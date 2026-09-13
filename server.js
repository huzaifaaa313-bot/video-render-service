// ============================================================
// UNIVERSAL VIDEO & AUDIO RENDER MICROSERVICE — v3
// Handles: Ken Burns pan/zoom, text motion graphics,
// and free neural text-to-speech (Edge TTS) with automatic
// long-script chunking and audio concatenation.
// ============================================================

const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EdgeTTS } = require('node-edge-tts');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.RENDER_API_SECRET;
const FONT_PATH = process.env.FONT_PATH || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

// ------------------------------------------------------------
// CONCURRENCY GUARDS — separate limits per resource type,
// since video rendering (CPU-bound) and TTS (network-bound)
// have very different resource profiles on 512MB free-tier RAM.
// ------------------------------------------------------------

const MAX_CONCURRENT_VIDEO_RENDERS = 2;
const MAX_CONCURRENT_TTS = 3;
let activeVideoRenders = 0;
let activeTtsJobs = 0;

function logEvent(requestId, message) {
	console.log(`[${new Date().toISOString()}] [${requestId}] ${message}`);
}

// ------------------------------------------------------------
// SECURITY
// ------------------------------------------------------------

function requireApiSecret(req, res, next) {
	const provided = req.header('x-api-secret');

	if (!API_SECRET) {
		return res.status(500).json({ error: 'SERVER_MISCONFIGURED: RENDER_API_SECRET is not set on the server.' });
	}

	if (!provided || provided !== API_SECRET) {
		return res.status(401).json({ error: 'UNAUTHORIZED: missing or invalid x-api-secret header.' });
	}

	next();
}

// ------------------------------------------------------------
// VALIDATION HELPERS
// ------------------------------------------------------------

const HEX_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;
const MAX_TEXT_LENGTH = 200;
const MAX_TTS_TEXT_LENGTH = 50000; // generous ceiling for a ~20-minute script

function isValidHttpUrl(value) {
	try {
		const parsed = new URL(value);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

function validateColor(value, fallback) {
	if (!value) return fallback;
	return HEX_COLOR_REGEX.test(value) ? value : fallback;
}

// ------------------------------------------------------------
// FILE HELPERS
// ------------------------------------------------------------

function makeTempPath(requestId, extension, suffix = '') {
	const fileName = `render_${requestId}_${suffix}${crypto.randomBytes(4).toString('hex')}.${extension}`;
	return path.join(os.tmpdir(), fileName);
}

async function downloadToFile(url, destPath) {
	const response = await axios({
		method: 'GET',
		url,
		responseType: 'stream',
		timeout: 30000,
		maxContentLength: 25 * 1024 * 1024
	});

	await new Promise((resolve, reject) => {
		const writer = fs.createWriteStream(destPath);
		response.data.pipe(writer);
		writer.on('finish', resolve);
		writer.on('error', reject);
		response.data.on('error', reject);
	});
}

function cleanupFiles(requestId, ...filePaths) {
	for (const filePath of filePaths) {
		fs.unlink(filePath, (err) => {
			if (err && err.code !== 'ENOENT') {
				logEvent(requestId, `WARNING: failed to clean up ${filePath}: ${err.message}`);
			}
		});
	}
}

// ------------------------------------------------------------
// RENDER TYPE: KEN BURNS (image pan/zoom)
// ------------------------------------------------------------

function buildKenBurnsFilter({ zoomDirection, panDirection, durationSeconds, fps }) {
	const totalFrames = Math.round(durationSeconds * fps);

	const zoomExpr =
		zoomDirection === 'out'
			? `if(lte(zoom,1.0),1.3,max(1.001,zoom-0.0008))`
			: `min(zoom+0.0008,1.3)`;

	const panMap = {
		right: { x: `(iw-iw/zoom)*on/${totalFrames}`, y: `ih/2-(ih/zoom/2)` },
		left: { x: `(iw-iw/zoom)*(1-on/${totalFrames})`, y: `ih/2-(ih/zoom/2)` },
		top: { x: `iw/2-(iw/zoom/2)`, y: `(ih-ih/zoom)*(1-on/${totalFrames})` },
		bottom: { x: `iw/2-(iw/zoom/2)`, y: `(ih-ih/zoom)*on/${totalFrames}` }
	};

	const pan = panMap[panDirection] || panMap.right;

	return (
		`zoompan=z='${zoomExpr}':x='${pan.x}':y='${pan.y}':` +
		`d=${totalFrames}:s=1920x1080:fps=${fps}`
	);
}

async function renderKenBurns({ imageUrl, durationSeconds, zoomDirection, panDirection, requestId }, outputPath) {
	const inputPath = makeTempPath(requestId, 'jpg', 'kb_src_');
	await downloadToFile(imageUrl, inputPath);

	const fps = 30;
	const filter = buildKenBurnsFilter({ zoomDirection, panDirection, durationSeconds, fps });

	await new Promise((resolve, reject) => {
		const command = ffmpeg(inputPath)
			.loop(durationSeconds)
			.videoFilters(filter)
			.outputOptions(['-pix_fmt yuv420p', '-movflags +faststart'])
			.duration(durationSeconds)
			.fps(fps)
			.output(outputPath);

		const timeoutHandle = setTimeout(() => {
			command.kill('SIGKILL');
			reject(new Error('RENDER_TIMEOUT: Ken Burns render exceeded 60 seconds.'));
		}, 60000);

		command
			.on('end', () => { clearTimeout(timeoutHandle); resolve(); })
			.on('error', (err) => { clearTimeout(timeoutHandle); reject(err); })
			.run();
	});

	cleanupFiles(requestId, inputPath);
}

// ------------------------------------------------------------
// RENDER TYPE: TEXT MOTION GRAPHIC
// ------------------------------------------------------------

function escapeForDrawtext(text) {
	return String(text)
		.replace(/\\/g, '\\\\')
		.replace(/:/g, '\\:')
		.replace(/'/g, '\u2019')
		.replace(/%/g, '\\%');
}

async function renderTextMotion({ text, durationSeconds, backgroundColor, fontColor, requestId }, outputPath) {
	const safeText = escapeForDrawtext(text);
	const fps = 30;

	const fadeInEnd = 0.6;
	const fadeOutStart = Math.max(fadeInEnd, durationSeconds - 0.6);

	if (!fs.existsSync(FONT_PATH)) {
		throw new Error(`FONT_NOT_FOUND: expected font at ${FONT_PATH}. Check the Dockerfile installed fonts correctly.`);
	}

	const drawtext =
		`drawtext=fontfile='${FONT_PATH}':text='${safeText}':fontsize=90:fontcolor=${fontColor}:` +
		`x=(w-text_w)/2:y=(h-text_h)/2:` +
		`alpha='if(lt(t,${fadeInEnd}),t/${fadeInEnd},if(gt(t,${fadeOutStart}),(${durationSeconds}-t)/0.6,1))'`;

	await new Promise((resolve, reject) => {
		const command = ffmpeg()
			.input(`color=c=${backgroundColor}:s=1920x1080:d=${durationSeconds}:r=${fps}`)
			.inputFormat('lavfi')
			.videoFilters(drawtext)
			.outputOptions(['-pix_fmt yuv420p', '-movflags +faststart'])
			.duration(durationSeconds)
			.output(outputPath);

		const timeoutHandle = setTimeout(() => {
			command.kill('SIGKILL');
			reject(new Error('RENDER_TIMEOUT: text motion render exceeded 60 seconds.'));
		}, 60000);

		command
			.on('end', () => { clearTimeout(timeoutHandle); resolve(); })
			.on('error', (err) => { clearTimeout(timeoutHandle); reject(err); })
			.run();
	});
}

// ------------------------------------------------------------
// RENDER TYPE: TEXT-TO-SPEECH (Edge TTS, with long-script
// chunking and seamless concatenation into one audio file)
// ------------------------------------------------------------

// Default voices by language — n8n can always override with an
// explicit `voice` parameter for full control.
const DEFAULT_VOICE_BY_LANGUAGE = {
	english: 'en-US-AndrewNeural',
	urdu: 'ur-PK-AsadNeural',
	hindi: 'hi-IN-MadhurNeural'
};

// Splits long text into TTS-safe chunks, breaking at sentence
// boundaries (Urdu '۔', and standard '.', '!', '?') so no chunk
// cuts a sentence in half — this keeps narration natural across
// chunk boundaries once concatenated.
function splitTextIntoChunks(text, maxChunkLength = 1600) {
	const sentenceEndRegex = /([۔!?.]+)\s*/g;
	const sentences = [];
	let lastIndex = 0;
	let match;

	while ((match = sentenceEndRegex.exec(text)) !== null) {
		sentences.push(text.slice(lastIndex, match.index + match[0].length).trim());
		lastIndex = sentenceEndRegex.lastIndex;
	}
	if (lastIndex < text.length) {
		sentences.push(text.slice(lastIndex).trim());
	}

	const chunks = [];
	let current = '';

	for (const sentence of sentences) {
		if (!sentence) continue;

		if ((current + ' ' + sentence).trim().length > maxChunkLength && current) {
			chunks.push(current.trim());
			current = sentence;
		} else {
			current = (current + ' ' + sentence).trim();
		}
	}
	if (current) chunks.push(current.trim());

	return chunks.length > 0 ? chunks : [text];
}

async function synthesizeChunk({ text, voice, requestId, chunkIndex }, outputPath) {
	const tts = new EdgeTTS({
		voice,
		outputFormat: 'audio-24khz-96kbitrate-mono-mp3',
		timeout: 15000
	});

	const MAX_ATTEMPTS = 2;
	let lastError;

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			await tts.ttsPromise(text, outputPath);
			return;
		} catch (err) {
			lastError = err;
			logEvent(requestId, `Chunk ${chunkIndex} attempt ${attempt} failed: ${err.message}`);
		}
	}

	throw new Error(`TTS_CHUNK_FAILED: chunk ${chunkIndex} failed after ${MAX_ATTEMPTS} attempts: ${lastError.message}`);
}

async function concatenateAudioFiles(chunkPaths, outputPath, requestId) {
	if (chunkPaths.length === 1) {
		fs.copyFileSync(chunkPaths[0], outputPath);
		return;
	}

	const listPath = makeTempPath(requestId, 'txt', 'concat_list_');
	const listContent = chunkPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
	fs.writeFileSync(listPath, listContent);

	await new Promise((resolve, reject) => {
		ffmpeg()
			.input(listPath)
			.inputOptions(['-f concat', '-safe 0'])
			.outputOptions(['-c copy'])
			.output(outputPath)
			.on('end', resolve)
			.on('error', reject)
			.run();
	});

	cleanupFiles(requestId, listPath);
}

async function renderTextToSpeech({ text, voice, requestId }, outputPath) {
	const chunks = splitTextIntoChunks(text);
	logEvent(requestId, `TTS: split script into ${chunks.length} chunk(s).`);

	const chunkPaths = [];

	try {
		for (let i = 0; i < chunks.length; i++) {
			const chunkPath = makeTempPath(requestId, 'mp3', `tts_chunk${i}_`);
			await synthesizeChunk({ text: chunks[i], voice, requestId, chunkIndex: i + 1 }, chunkPath);
			chunkPaths.push(chunkPath);
			logEvent(requestId, `TTS: chunk ${i + 1}/${chunks.length} synthesized.`);
		}

		await concatenateAudioFiles(chunkPaths, outputPath, requestId);
		logEvent(requestId, 'TTS: all chunks concatenated into final audio.');

	} finally {
		cleanupFiles(requestId, ...chunkPaths);
	}
}

// ------------------------------------------------------------
// MAIN ENDPOINT
// ------------------------------------------------------------

app.post('/render', requireApiSecret, async (req, res) => {
	const requestId = crypto.randomBytes(4).toString('hex');
	const { type } = req.body;

	logEvent(requestId, `Incoming request, type="${type}"`);

	if (!type) {
		return res.status(400).json({ error: 'VALIDATION_ERROR: "type" is required (kenburns | textmotion | tts).', request_id: requestId });
	}

	const isTts = type === 'tts';
	const activeCount = isTts ? activeTtsJobs : activeVideoRenders;
	const maxCount = isTts ? MAX_CONCURRENT_TTS : MAX_CONCURRENT_VIDEO_RENDERS;

	if (activeCount >= maxCount) {
		logEvent(requestId, `REJECTED: at capacity (${activeCount}/${maxCount}) for type=${type}.`);
		return res.status(429).json({
			error: 'SERVER_BUSY: maximum concurrent jobs reached for this type. Retry in a few seconds.',
			request_id: requestId
		});
	}

	if (isTts) activeTtsJobs++; else activeVideoRenders++;

	const extension = isTts ? 'mp3' : 'mp4';
	const outputPath = makeTempPath(requestId, extension, 'out_');

	try {
		if (type === 'kenburns') {
			const { image_url, duration, zoom, pan } = req.body;

			if (!image_url || !isValidHttpUrl(image_url)) {
				return res.status(400).json({ error: 'VALIDATION_ERROR: "image_url" must be a valid http(s) URL.', request_id: requestId });
			}

			const durationSeconds = Math.max(2, Math.min(20, Number(duration) || 6));
			const zoomDirection = zoom === 'out' ? 'out' : 'in';
			const panDirection = ['right', 'left', 'top', 'bottom'].includes(pan) ? pan : 'right';

			await renderKenBurns({ imageUrl: image_url, durationSeconds, zoomDirection, panDirection, requestId }, outputPath);

		} else if (type === 'textmotion') {
			const { text, duration, background_color, font_color } = req.body;

			if (!text || String(text).trim().length === 0) {
				return res.status(400).json({ error: 'VALIDATION_ERROR: "text" is required for textmotion.', request_id: requestId });
			}
			if (String(text).length > MAX_TEXT_LENGTH) {
				return res.status(400).json({ error: `VALIDATION_ERROR: "text" exceeds max length of ${MAX_TEXT_LENGTH} characters.`, request_id: requestId });
			}

			const durationSeconds = Math.max(2, Math.min(15, Number(duration) || 4));
			const bg = validateColor(background_color, '#1A1A2E');
			const fg = validateColor(font_color, '#FFFFFF');

			await renderTextMotion({ text, durationSeconds, backgroundColor: bg, fontColor: fg, requestId }, outputPath);

		} else if (type === 'tts') {
			const { text, language, voice: voiceOverride } = req.body;

			if (!text || String(text).trim().length === 0) {
				return res.status(400).json({ error: 'VALIDATION_ERROR: "text" is required for tts.', request_id: requestId });
			}
			if (String(text).length > MAX_TTS_TEXT_LENGTH) {
				return res.status(400).json({ error: `VALIDATION_ERROR: "text" exceeds max length of ${MAX_TTS_TEXT_LENGTH} characters.`, request_id: requestId });
			}

			const languageKey = String(language || 'english').toLowerCase();
			const voice = voiceOverride || DEFAULT_VOICE_BY_LANGUAGE[languageKey] || DEFAULT_VOICE_BY_LANGUAGE.english;

			await renderTextToSpeech({ text: String(text).trim(), voice, requestId }, outputPath);

		} else {
			return res.status(400).json({ error: `VALIDATION_ERROR: unknown type "${type}". Supported: kenburns, textmotion, tts.`, request_id: requestId });
		}

		if (!fs.existsSync(outputPath)) {
			throw new Error('RENDER_ERROR: output file was not created.');
		}

		logEvent(requestId, 'Job succeeded, streaming response.');

		res.setHeader('Content-Type', isTts ? 'audio/mpeg' : 'video/mp4');
		res.setHeader('x-request-id', requestId);
		const stream = fs.createReadStream(outputPath);
		stream.pipe(res);
		stream.on('close', () => cleanupFiles(requestId, outputPath));

	} catch (err) {
		cleanupFiles(requestId, outputPath);
		logEvent(requestId, `FAILURE: ${err.message}`);
		res.status(500).json({ error: `FAILURE: ${err.message}`, request_id: requestId });

	} finally {
		if (isTts) activeTtsJobs--; else activeVideoRenders--;
	}
});

// ------------------------------------------------------------
// HEALTH CHECK
// ------------------------------------------------------------

app.get('/health', (req, res) => {
	ffmpeg.getAvailableFormats((err) => {
		if (err) {
			return res.status(503).json({ status: 'degraded', ffmpeg_available: false, error: err.message });
		}
		res.json({
			status: 'ok',
			service: 'video-render-service',
			ffmpeg_available: true,
			active_video_renders: activeVideoRenders,
			active_tts_jobs: activeTtsJobs,
			time: new Date().toISOString()
		});
	});
});

// ------------------------------------------------------------
// GRACEFUL SHUTDOWN
// ------------------------------------------------------------

const server = app.listen(PORT, () => {
	console.log(`Video & audio render service listening on port ${PORT}`);
});

process.on('SIGTERM', () => {
	console.log('SIGTERM received, shutting down gracefully...');
	server.close(() => {
		console.log('Server closed.');
		process.exit(0);
	});
});

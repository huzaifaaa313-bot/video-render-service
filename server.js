// ============================================================
// UNIVERSAL VIDEO & AUDIO RENDER MICROSERVICE — v6
// Ken Burns (URL or base64 image source), text motion graphics,
// Edge TTS (chunked + concatenated). Voice/rate/pitch decisions
// live in n8n — this service only renders, but validates
// whatever it receives before trusting it.
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
app.use(express.json({ limit: '15mb' })); // raised for base64 image payloads

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.RENDER_API_SECRET;
const FONT_PATH = process.env.FONT_PATH || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const TEMP_PREFIX = 'render_';

const MAX_CONCURRENT_VIDEO_RENDERS = 2;
const MAX_CONCURRENT_TTS = 3;
let activeVideoRenders = 0;
let activeTtsJobs = 0;

function logEvent(id, msg) { console.log(`[${new Date().toISOString()}] [${id}] ${msg}`); }

(function cleanupStaleTempFilesOnStartup() {
	const cutoff = Date.now() - 10 * 60 * 1000;
	fs.readdir(os.tmpdir(), (err, files) => {
		if (err) return;
		for (const f of files) {
			if (!f.startsWith(TEMP_PREFIX)) continue;
			const full = path.join(os.tmpdir(), f);
			fs.stat(full, (e, stat) => { if (!e && stat.mtimeMs < cutoff) fs.unlink(full, () => {}); });
		}
	});
})();

function requireApiSecret(req, res, next) {
	const provided = req.header('x-api-secret');
	if (!API_SECRET) return res.status(500).json({ error: 'SERVER_MISCONFIGURED: RENDER_API_SECRET is not set.' });
	if (!provided || provided !== API_SECRET) return res.status(401).json({ error: 'UNAUTHORIZED: missing or invalid x-api-secret header.' });
	next();
}

const HEX_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;
const RATE_REGEX = /^[+-]\d{1,3}%$/;
const PITCH_REGEX = /^[+-]\d{1,3}Hz$/;
const VOICE_REGEX = /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z]+Neural$/i;
const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_TEXT_LENGTH = 200;
const MAX_TTS_TEXT_LENGTH = 50000;

function isValidHttpUrl(v) { try { const p = new URL(v); return p.protocol === 'http:' || p.protocol === 'https:'; } catch { return false; } }
function validateColor(v, fb) { return v && HEX_COLOR_REGEX.test(v) ? v : fb; }
function validateRate(v) { return v && RATE_REGEX.test(v) ? v : '+0%'; }
function validatePitch(v) { return v && PITCH_REGEX.test(v) ? v : '+0Hz'; }
function validateVoice(v) { return v && VOICE_REGEX.test(v) ? v : null; }
function isValidBase64(v) { return typeof v === 'string' && v.length > 100 && BASE64_REGEX.test(v); }

function makeTempPath(id, ext, suffix = '') { return path.join(os.tmpdir(), `${TEMP_PREFIX}${id}_${suffix}${crypto.randomBytes(4).toString('hex')}.${ext}`); }

async function downloadToFile(url, dest) {
	const res = await axios({ method: 'GET', url, responseType: 'stream', timeout: 30000, maxContentLength: 25 * 1024 * 1024 });
	await new Promise((resolve, reject) => {
		const w = fs.createWriteStream(dest);
		res.data.pipe(w);
		w.on('finish', resolve); w.on('error', reject); res.data.on('error', reject);
	});
}

function cleanupFiles(id, ...paths) {
	for (const f of paths) fs.unlink(f, (err) => { if (err && err.code !== 'ENOENT') logEvent(id, `WARNING: cleanup failed for ${f}: ${err.message}`); });
}

// ------------------------------------------------------------ KEN BURNS
function buildKenBurnsFilter({ zoomDirection, panDirection, durationSeconds, fps }) {
	const totalFrames = Math.round(durationSeconds * fps);
	const zoomExpr = zoomDirection === 'out' ? `if(lte(zoom,1.0),1.3,max(1.001,zoom-0.0008))` : `min(zoom+0.0008,1.3)`;
	const panMap = {
		right: { x: `(iw-iw/zoom)*on/${totalFrames}`, y: `ih/2-(ih/zoom/2)` },
		left: { x: `(iw-iw/zoom)*(1-on/${totalFrames})`, y: `ih/2-(ih/zoom/2)` },
		top: { x: `iw/2-(iw/zoom/2)`, y: `(ih-ih/zoom)*(1-on/${totalFrames})` },
		bottom: { x: `iw/2-(iw/zoom/2)`, y: `(ih-ih/zoom)*on/${totalFrames}` }
	};
	const pan = panMap[panDirection] || panMap.right;
	return `zoompan=z='${zoomExpr}':x='${pan.x}':y='${pan.y}':d=${totalFrames}:s=1920x1080:fps=${fps}`;
}

// Accepts EITHER a downloadable imageUrl OR raw imageBase64 (e.g. from
// Gemini's inline image response) — exactly one source is used.
async function renderKenBurns({ imageUrl, imageBase64, durationSeconds, zoomDirection, panDirection, requestId }, outputPath) {
	const inputPath = makeTempPath(requestId, 'jpg', 'kb_src_');

	if (imageBase64) {
		fs.writeFileSync(inputPath, Buffer.from(imageBase64, 'base64'));
	} else {
		await downloadToFile(imageUrl, inputPath);
	}

	const fps = 30;
	const filter = buildKenBurnsFilter({ zoomDirection, panDirection, durationSeconds, fps });
	await new Promise((resolve, reject) => {
		const cmd = ffmpeg(inputPath).loop(durationSeconds).videoFilters(filter)
			.outputOptions(['-pix_fmt yuv420p', '-movflags +faststart']).duration(durationSeconds).fps(fps).output(outputPath);
		const t = setTimeout(() => { cmd.kill('SIGKILL'); reject(new Error('RENDER_TIMEOUT: Ken Burns exceeded 60s.')); }, 60000);
		cmd.on('end', () => { clearTimeout(t); resolve(); }).on('error', (e) => { clearTimeout(t); reject(e); }).run();
	});
	cleanupFiles(requestId, inputPath);
}

// ------------------------------------------------------------ TEXT MOTION
function escapeForDrawtext(t) { return String(t).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, '\u2019').replace(/%/g, '\\%'); }

async function renderTextMotion({ text, durationSeconds, backgroundColor, fontColor, requestId }, outputPath) {
	const safeText = escapeForDrawtext(text);
	const fps = 30, fadeInEnd = 0.6, fadeOutStart = Math.max(fadeInEnd, durationSeconds - 0.6);
	if (!fs.existsSync(FONT_PATH)) throw new Error(`FONT_NOT_FOUND: expected font at ${FONT_PATH}.`);
	const drawtext = `drawtext=fontfile='${FONT_PATH}':text='${safeText}':fontsize=90:fontcolor=${fontColor}:` +
		`x=(w-text_w)/2:y=(h-text_h)/2:alpha='if(lt(t,${fadeInEnd}),t/${fadeInEnd},if(gt(t,${fadeOutStart}),(${durationSeconds}-t)/0.6,1))'`;
	await new Promise((resolve, reject) => {
		const cmd = ffmpeg().input(`color=c=${backgroundColor}:s=1920x1080:d=${durationSeconds}:r=${fps}`).inputFormat('lavfi')
			.videoFilters(drawtext).outputOptions(['-pix_fmt yuv420p', '-movflags +faststart']).duration(durationSeconds).output(outputPath);
		const t = setTimeout(() => { cmd.kill('SIGKILL'); reject(new Error('RENDER_TIMEOUT: text motion exceeded 60s.')); }, 60000);
		cmd.on('end', () => { clearTimeout(t); resolve(); }).on('error', (e) => { clearTimeout(t); reject(e); }).run();
	});
}

// ------------------------------------------------------------ TTS
function splitTextIntoChunks(text, maxLen = 1600) {
	const re = /([۔!?.]+)\s*/g;
	const sentences = []; let last = 0, m;
	while ((m = re.exec(text)) !== null) { sentences.push(text.slice(last, m.index + m[0].length).trim()); last = re.lastIndex; }
	if (last < text.length) sentences.push(text.slice(last).trim());
	const chunks = []; let cur = '';
	for (const s of sentences) {
		if (!s) continue;
		if ((cur + ' ' + s).trim().length > maxLen && cur) { chunks.push(cur.trim()); cur = s; } else cur = (cur + ' ' + s).trim();
	}
	if (cur) chunks.push(cur.trim());
	return chunks.length > 0 ? chunks : [text];
}

async function synthesizeChunk({ text, voice, rate, pitch, requestId, chunkIndex }, outputPath) {
	const tts = new EdgeTTS({ voice, rate, pitch, outputFormat: 'audio-24khz-96kbitrate-mono-mp3', timeout: 15000 });
	let lastError;
	for (let attempt = 1; attempt <= 2; attempt++) {
		try { await tts.ttsPromise(text, outputPath); return; }
		catch (err) { lastError = err; logEvent(requestId, `Chunk ${chunkIndex} attempt ${attempt} failed: ${err.message}`); }
	}
	throw new Error(`TTS_CHUNK_FAILED: chunk ${chunkIndex} failed after 2 attempts: ${lastError.message}`);
}

async function concatenateAudioFiles(paths, outputPath, requestId) {
	if (paths.length === 1) { fs.copyFileSync(paths[0], outputPath); return; }
	const listPath = makeTempPath(requestId, 'txt', 'concat_');
	fs.writeFileSync(listPath, paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
	await new Promise((resolve, reject) => {
		ffmpeg().input(listPath).inputOptions(['-f concat', '-safe 0']).outputOptions(['-c copy']).output(outputPath)
			.on('end', resolve).on('error', reject).run();
	});
	cleanupFiles(requestId, listPath);
}

async function renderTextToSpeech({ text, voice, rate, pitch, requestId }, outputPath) {
	const chunks = splitTextIntoChunks(text);
	logEvent(requestId, `TTS: ${chunks.length} chunk(s), voice=${voice}, rate=${rate}, pitch=${pitch}.`);
	const chunkPaths = [];
	try {
		for (let i = 0; i < chunks.length; i++) {
			const cp = makeTempPath(requestId, 'mp3', `tts${i}_`);
			await synthesizeChunk({ text: chunks[i], voice, rate, pitch, requestId, chunkIndex: i + 1 }, cp);
			chunkPaths.push(cp);
		}
		await concatenateAudioFiles(chunkPaths, outputPath, requestId);
	} finally { cleanupFiles(requestId, ...chunkPaths); }
}

// ------------------------------------------------------------ MAIN ENDPOINT
app.post('/render', requireApiSecret, async (req, res) => {
	const requestId = crypto.randomBytes(4).toString('hex');
	const { type } = req.body;
	logEvent(requestId, `Incoming request, type="${type}"`);

	if (!type) return res.status(400).json({ error: 'VALIDATION_ERROR: "type" is required (kenburns | textmotion | tts).', request_id: requestId });

	const isTts = type === 'tts';
	const activeCount = isTts ? activeTtsJobs : activeVideoRenders;
	const maxCount = isTts ? MAX_CONCURRENT_TTS : MAX_CONCURRENT_VIDEO_RENDERS;
	if (activeCount >= maxCount) return res.status(429).json({ error: 'SERVER_BUSY: max concurrent jobs reached. Retry shortly.', request_id: requestId });
	if (isTts) activeTtsJobs++; else activeVideoRenders++;

	const outputPath = makeTempPath(requestId, isTts ? 'mp3' : 'mp4', 'out_');

	try {
		if (type === 'kenburns') {
			const { image_url, image_base64, duration, zoom, pan } = req.body;

			if (!image_url && !image_base64) {
				return res.status(400).json({ error: 'VALIDATION_ERROR: provide either "image_url" or "image_base64".', request_id: requestId });
			}
			if (image_url && !isValidHttpUrl(image_url)) {
				return res.status(400).json({ error: 'VALIDATION_ERROR: "image_url" must be a valid http(s) URL.', request_id: requestId });
			}
			if (image_base64 && !isValidBase64(image_base64)) {
				return res.status(400).json({ error: 'VALIDATION_ERROR: "image_base64" does not look like valid base64 data.', request_id: requestId });
			}

			await renderKenBurns({
				imageUrl: image_url,
				imageBase64: image_base64,
				durationSeconds: Math.max(2, Math.min(20, Number(duration) || 6)),
				zoomDirection: zoom === 'out' ? 'out' : 'in',
				panDirection: ['right', 'left', 'top', 'bottom'].includes(pan) ? pan : 'right',
				requestId
			}, outputPath);

		} else if (type === 'textmotion') {
			const { text, duration, background_color, font_color } = req.body;
			if (!text || String(text).trim().length === 0) return res.status(400).json({ error: 'VALIDATION_ERROR: "text" is required.', request_id: requestId });
			if (String(text).length > MAX_TEXT_LENGTH) return res.status(400).json({ error: `VALIDATION_ERROR: "text" exceeds ${MAX_TEXT_LENGTH} chars.`, request_id: requestId });
			await renderTextMotion({
				text, durationSeconds: Math.max(2, Math.min(15, Number(duration) || 4)),
				backgroundColor: validateColor(background_color, '#1A1A2E'), fontColor: validateColor(font_color, '#FFFFFF'), requestId
			}, outputPath);

		} else if (type === 'tts') {
			const { text, voice, rate, pitch } = req.body;
			if (!text || String(text).trim().length === 0) return res.status(400).json({ error: 'VALIDATION_ERROR: "text" is required.', request_id: requestId });
			if (String(text).length > MAX_TTS_TEXT_LENGTH) return res.status(400).json({ error: `VALIDATION_ERROR: "text" exceeds ${MAX_TTS_TEXT_LENGTH} chars.`, request_id: requestId });
			const safeVoice = validateVoice(voice);
			if (!safeVoice) return res.status(400).json({ error: `VALIDATION_ERROR: "voice" must match format "xx-XX-NameNeural", got "${voice}".`, request_id: requestId });
			await renderTextToSpeech({ text: String(text).trim(), voice: safeVoice, rate: validateRate(rate), pitch: validatePitch(pitch), requestId }, outputPath);

		} else {
			return res.status(400).json({ error: `VALIDATION_ERROR: unknown type "${type}".`, request_id: requestId });
		}

		if (!fs.existsSync(outputPath)) throw new Error('RENDER_ERROR: output file was not created.');

		res.setHeader('Content-Type', isTts ? 'audio/mpeg' : 'video/mp4');
		res.setHeader('x-request-id', requestId);
		const stream = fs.createReadStream(outputPath);
		stream.on('error', (e) => { logEvent(requestId, `STREAM_ERROR: ${e.message}`); if (!res.headersSent) res.status(500).end(); });
		stream.pipe(res);
		stream.on('close', () => cleanupFiles(requestId, outputPath));

	} catch (err) {
		cleanupFiles(requestId, outputPath);
		logEvent(requestId, `FAILURE: ${err.message}`);
		if (!res.headersSent) res.status(500).json({ error: `FAILURE: ${err.message}`, request_id: requestId });
	} finally {
		if (isTts) activeTtsJobs--; else activeVideoRenders--;
	}
});

app.get('/health', (req, res) => {
	ffmpeg.getAvailableFormats((err) => {
		if (err) return res.status(503).json({ status: 'degraded', ffmpeg_available: false, error: err.message });
		res.json({ status: 'ok', service: 'video-render-service', ffmpeg_available: true, active_video_renders: activeVideoRenders, active_tts_jobs: activeTtsJobs, time: new Date().toISOString() });
	});
});

const server = app.listen(PORT, () => console.log(`Render service listening on port ${PORT}`));
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });

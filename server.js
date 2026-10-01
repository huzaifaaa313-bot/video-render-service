// ============================================================
// UNIVERSAL VIDEO & AUDIO RENDER + ASSEMBLY MICROSERVICE — v8
// Job/shot-scoped storage, per-shot mux+subtitle-burn+normalize,
// codec-safe final concatenation. Replaces Shotstack entirely.
// ============================================================

const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EdgeTTS } = require('node-edge-tts');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '15mb' }));
const upload = multer({ limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB cap per file

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.RENDER_API_SECRET;
const FONT_PATH = process.env.FONT_PATH || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const TARGET_W = 1920, TARGET_H = 1080, TARGET_FPS = 30;

// ------------------------------------------------------------ SECURITY
function requireApiSecret(req, res, next) {
	const provided = req.header('x-api-secret');
	if (!API_SECRET) return res.status(500).json({ error: 'SERVER_MISCONFIGURED: RENDER_API_SECRET not set.' });
	if (!provided || provided !== API_SECRET) return res.status(401).json({ error: 'UNAUTHORIZED: missing/invalid x-api-secret header.' });
	next();
}

function logEvent(id, msg) { console.log(`[${new Date().toISOString()}] [${id}] ${msg}`); }

// Basic SSRF guard: refuse to fetch from private/loopback hosts.
const PRIVATE_HOST_REGEX = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.0\.0\.0|::1)/i;
function isSafeExternalUrl(url) {
	try {
		const u = new URL(url);
		if (!['http:', 'https:'].includes(u.protocol)) return false;
		if (PRIVATE_HOST_REGEX.test(u.hostname)) return false;
		return true;
	} catch { return false; }
}

// ------------------------------------------------------------ JOB STORE (path-safe)
const JOB_STORE_ROOT = path.join(os.tmpdir(), 'job_store');
if (!fs.existsSync(JOB_STORE_ROOT)) fs.mkdirSync(JOB_STORE_ROOT, { recursive: true });

function safeId(id) {
	const clean = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
	if (!clean) throw new Error('INVALID_ID: id is empty after sanitization.');
	return clean;
}

function jobPath(jobId, ...segments) {
	const base = path.join(JOB_STORE_ROOT, safeId(jobId));
	const full = path.join(base, ...segments.map(safeId_or_file));
	const resolvedBase = path.resolve(base);
	const resolvedFull = path.resolve(full);
	if (!resolvedFull.startsWith(resolvedBase)) throw new Error('PATH_TRAVERSAL_BLOCKED');
	return resolvedFull;
}
function safeId_or_file(s) {
	// allows subfolder names and "shotid.ext" filenames, still strips traversal chars
	return String(s).replace(/[^a-zA-Z0-9_.\-]/g, '_');
}

function ensureJobDirs(jobId) {
	for (const sub of ['assets', 'audio', 'subtitles', 'shots', 'final', 'temp']) {
		const p = jobPath(jobId, sub);
		if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
	}
}

function cleanupJob(jobId) {
	const base = jobPath(jobId);
	fs.rm(base, { recursive: true, force: true }, () => {});
}

// ------------------------------------------------------------ BOUNDED CONCURRENCY (semaphore + 429)
function makeGate(maxConcurrent) {
	let active = 0;
	return {
		tryEnter() { if (active >= maxConcurrent) return false; active++; return true; },
		leave() { active = Math.max(0, active - 1); },
		get active() { return active; }
	};
}
const renderGate = makeGate(2);
const ttsGate = makeGate(3);
const assembleGate = makeGate(1); // assembly is heavy; one at a time

function busyResponse(res, requestId, retryAfterSeconds = 10) {
	res.setHeader('Retry-After', String(retryAfterSeconds));
	return res.status(429).json({ error: 'SERVER_BUSY: capacity reached.', retry_after_seconds: retryAfterSeconds, request_id: requestId });
}

// ------------------------------------------------------------ FFMPEG HELPERS
function runFfmpeg(build, timeoutMs, requestId) {
	return new Promise((resolve, reject) => {
		const cmd = build(ffmpeg());
		let stderr = '';
		const t = setTimeout(() => { cmd.kill('SIGKILL'); reject(new Error(`FFMPEG_TIMEOUT after ${timeoutMs}ms`)); }, timeoutMs);
		cmd
			.on('stderr', (line) => { stderr += line + '\n'; })
			.on('end', () => { clearTimeout(t); resolve(); })
			.on('error', (err) => { clearTimeout(t); reject(new Error(`${err.message} | ffmpeg stderr tail: ${stderr.slice(-500)}`)); })
			.run();
	});
}

function probeDuration(filePath) {
	return new Promise((resolve, reject) => {
		ffmpeg.ffprobe(filePath, (err, data) => {
			if (err) return reject(new Error(`FFPROBE_FAILED: ${err.message}`));
			const duration = data?.format?.duration;
			if (!duration || duration <= 0) return reject(new Error('FFPROBE_FAILED: no valid duration found.'));
			resolve(duration);
		});
	});
}

function validateMediaFile(filePath, expectKind) {
	return new Promise((resolve, reject) => {
		if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
			return reject(new Error('FILE_INVALID: missing or empty file.'));
		}
		if (expectKind === 'subtitle') return resolve(true); // text file, no ffprobe needed
		ffmpeg.ffprobe(filePath, (err, data) => {
			if (err) return reject(new Error(`FILE_INVALID: not a readable media file (${err.message}).`));
			const streams = data?.streams || [];
			if (expectKind === 'video' && !streams.some((s) => s.codec_type === 'video')) return reject(new Error('FILE_INVALID: no video stream found.'));
			if (expectKind === 'audio' && !streams.some((s) => s.codec_type === 'audio')) return reject(new Error('FILE_INVALID: no audio stream found.'));
			resolve(true);
		});
	});
}

async function downloadToFile(url, destPath, timeoutMs = 30000) {
	if (!isSafeExternalUrl(url)) throw new Error('UNSAFE_URL: refused to fetch this URL.');
	const res = await axios({ method: 'GET', url, responseType: 'stream', timeout: timeoutMs, maxContentLength: 100 * 1024 * 1024, maxRedirects: 5 });
	const contentType = res.headers['content-type'] || '';
	await new Promise((resolve, reject) => {
		const w = fs.createWriteStream(destPath);
		res.data.pipe(w);
		w.on('finish', resolve); w.on('error', reject); res.data.on('error', reject);
	});
	return contentType;
}

// ------------------------------------------------------------ KEN BURNS / TEXT MOTION (unchanged behavior, now job-aware)
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
	return `zoompan=z='${zoomExpr}':x='${pan.x}':y='${pan.y}':d=${totalFrames}:s=${TARGET_W}x${TARGET_H}:fps=${fps}`;
}

async function renderKenBurns({ imageUrl, imageBase64, durationSeconds, zoomDirection, panDirection, requestId }, outputPath) {
	const inputPath = outputPath + '.src.jpg';
	if (imageBase64) fs.writeFileSync(inputPath, Buffer.from(imageBase64, 'base64'));
	else await downloadToFile(imageUrl, inputPath);
	const filter = buildKenBurnsFilter({ zoomDirection, panDirection, durationSeconds, fps: TARGET_FPS });
	await runFfmpeg((c) => c.input(inputPath).loop(durationSeconds).videoFilters(filter)
		.outputOptions(['-pix_fmt yuv420p', '-movflags +faststart']).duration(durationSeconds).fps(TARGET_FPS).output(outputPath), 60000, requestId);
	fs.unlink(inputPath, () => {});
}

function escapeForDrawtext(t) { return String(t).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, '\u2019').replace(/%/g, '\\%'); }

async function renderTextMotion({ text, durationSeconds, backgroundColor, fontColor, requestId }, outputPath) {
	const safeText = escapeForDrawtext(text);
	const fadeInEnd = 0.6, fadeOutStart = Math.max(fadeInEnd, durationSeconds - 0.6);
	if (!fs.existsSync(FONT_PATH)) throw new Error(`FONT_NOT_FOUND: ${FONT_PATH}`);
	const drawtext = `drawtext=fontfile='${FONT_PATH}':text='${safeText}':fontsize=90:fontcolor=${fontColor}:` +
		`x=(w-text_w)/2:y=(h-text_h)/2:alpha='if(lt(t,${fadeInEnd}),t/${fadeInEnd},if(gt(t,${fadeOutStart}),(${durationSeconds}-t)/0.6,1))'`;
	await runFfmpeg((c) => c.input(`color=c=${backgroundColor}:s=${TARGET_W}x${TARGET_H}:d=${durationSeconds}:r=${TARGET_FPS}`).inputFormat('lavfi')
		.videoFilters(drawtext).outputOptions(['-pix_fmt yuv420p', '-movflags +faststart']).duration(durationSeconds).output(outputPath), 60000, requestId);
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
		catch (err) { lastError = err; logEvent(requestId, `TTS chunk ${chunkIndex} attempt ${attempt} failed: ${err.message}`); }
	}
	throw new Error(`TTS_CHUNK_FAILED after 2 attempts: ${lastError.message}`);
}

async function concatenateAudio(paths, outputPath, requestId) {
	if (paths.length === 1) { fs.copyFileSync(paths[0], outputPath); return; }
	const listPath = outputPath + '.list.txt';
	fs.writeFileSync(listPath, paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
	await runFfmpeg((c) => c.input(listPath).inputOptions(['-f concat', '-safe 0']).outputOptions(['-c copy']).output(outputPath), 60000, requestId);
	fs.unlink(listPath, () => {});
}

async function renderTextToSpeech({ text, voice, rate, pitch, requestId }, outputPath) {
	const chunks = splitTextIntoChunks(text);
	const chunkPaths = chunks.map((_, i) => outputPath + `.part${i}.mp3`);
	try {
		for (let i = 0; i < chunks.length; i++) await synthesizeChunk({ text: chunks[i], voice, rate, pitch, requestId, chunkIndex: i + 1 }, chunkPaths[i]);
		await concatenateAudio(chunkPaths, outputPath, requestId);
	} finally { chunkPaths.forEach((p) => fs.unlink(p, () => {})); }
}

// ------------------------------------------------------------ VALIDATORS
const RATE_REGEX = /^[+-]\d{1,3}%$/, PITCH_REGEX = /^[+-]\d{1,3}Hz$/, VOICE_REGEX = /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z]+Neural$/i;
const HEX_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;
function validColor(v, fb) { return v && HEX_COLOR_REGEX.test(v) ? v : fb; }

// ============================================================
// ENDPOINT: POST /render  (kenburns | textmotion | tts)
// Backward compatible. If job_id+shot_id given, output is ALSO
// persisted into that shot's job-store slot automatically.
// ============================================================
app.post('/render', requireApiSecret, async (req, res) => {
	const requestId = crypto.randomBytes(4).toString('hex');
	const { type, job_id, shot_id } = req.body;
	if (!type) return res.status(400).json({ error: 'VALIDATION_ERROR: "type" is required.', request_id: requestId });

	const isTts = type === 'tts';
	const gate = isTts ? ttsGate : renderGate;
	if (!gate.tryEnter()) return busyResponse(res, requestId);

	const outputPath = path.join(os.tmpdir(), `render_${requestId}.${isTts ? 'mp3' : 'mp4'}`);

	try {
		if (type === 'kenburns') {
			const { image_url, image_base64, duration, zoom, pan } = req.body;
			if (!image_url && !image_base64) return res.status(400).json({ error: 'VALIDATION_ERROR: provide "image_url" or "image_base64".', request_id: requestId });
			await renderKenBurns({
				imageUrl: image_url, imageBase64: image_base64,
				durationSeconds: Math.max(2, Math.min(20, Number(duration) || 6)),
				zoomDirection: zoom === 'out' ? 'out' : 'in',
				panDirection: ['right', 'left', 'top', 'bottom'].includes(pan) ? pan : 'right', requestId
			}, outputPath);

		} else if (type === 'textmotion') {
			const { text, duration, background_color, font_color } = req.body;
			if (!text?.trim()) return res.status(400).json({ error: 'VALIDATION_ERROR: "text" is required.', request_id: requestId });
			await renderTextMotion({
				text, durationSeconds: Math.max(2, Math.min(15, Number(duration) || 4)),
				backgroundColor: validColor(background_color, '#1A1A2E'), fontColor: validColor(font_color, '#FFFFFF'), requestId
			}, outputPath);

		} else if (type === 'tts') {
			const { text, voice, rate, pitch } = req.body;
			if (!text?.trim()) return res.status(400).json({ error: 'VALIDATION_ERROR: "text" is required.', request_id: requestId });
			if (!voice || !VOICE_REGEX.test(voice)) return res.status(400).json({ error: `VALIDATION_ERROR: "voice" must match "xx-XX-NameNeural", got "${voice}".`, request_id: requestId });
			const safeRate = rate && RATE_REGEX.test(rate) ? rate : '+0%';
			const safePitch = pitch && PITCH_REGEX.test(pitch) ? pitch : '+0Hz';
			await renderTextToSpeech({ text: text.trim(), voice, rate: safeRate, pitch: safePitch, requestId }, outputPath);

		} else {
			return res.status(400).json({ error: `VALIDATION_ERROR: unknown type "${type}".`, request_id: requestId });
		}

		if (job_id && shot_id) {
			ensureJobDirs(job_id);
			const dest = isTts ? jobPath(job_id, 'audio', `${shot_id}.mp3`) : jobPath(job_id, 'assets', `${shot_id}.mp4`);
			fs.copyFileSync(outputPath, dest);
		}

		res.setHeader('Content-Type', isTts ? 'audio/mpeg' : 'video/mp4');
		const stream = fs.createReadStream(outputPath);
		stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
		stream.pipe(res);
		stream.on('close', () => fs.unlink(outputPath, () => {}));

	} catch (err) {
		fs.unlink(outputPath, () => {});
		logEvent(requestId, `RENDER_FAILURE: ${err.message}`);
		if (!res.headersSent) res.status(500).json({ error: `RENDER_FAILURE: ${err.message}`, request_id: requestId });
	} finally {
		gate.leave();
	}
});

// ============================================================
// ENDPOINT: POST /store-existing
// Stores a visual asset (video or image), already-fetched by n8n,
// into job-scoped storage. Accepts multipart file OR a source_url.
// kind: "video" | "image" | "subtitle"  (audio uses /render tts path above)
// ============================================================
app.post('/store-existing', requireApiSecret, upload.single('file'), async (req, res) => {
	const requestId = crypto.randomBytes(4).toString('hex');
	try {
		const { job_id, shot_id, kind, source_url, subtitle_text } = req.body;
		if (!job_id || !shot_id || !kind) return res.status(400).json({ error: 'VALIDATION_ERROR: "job_id", "shot_id", "kind" are required.', request_id: requestId });
		if (!['video', 'image', 'subtitle'].includes(kind)) return res.status(400).json({ error: `VALIDATION_ERROR: unsupported kind "${kind}".`, request_id: requestId });

		ensureJobDirs(job_id);

		if (kind === 'subtitle') {
			if (!subtitle_text) return res.status(400).json({ error: 'VALIDATION_ERROR: "subtitle_text" required for kind=subtitle.', request_id: requestId });
			fs.writeFileSync(jobPath(job_id, 'subtitles', `${shot_id}.srt`), subtitle_text);
			return res.json({ status: 'STORED', job_id, shot_id, kind, request_id: requestId });
		}

		const tempPath = path.join(os.tmpdir(), `store_${requestId}.tmp`);
		if (req.file) {
			fs.writeFileSync(tempPath, req.file.buffer);
		} else if (source_url) {
			await downloadToFile(source_url, tempPath);
		} else {
			return res.status(400).json({ error: 'VALIDATION_ERROR: provide a "file" upload or "source_url".', request_id: requestId });
		}

		await validateMediaFile(tempPath, kind === 'image' ? undefined : 'video'); // images validated loosely below
		if (kind === 'image' && !fs.existsSync(tempPath)) throw new Error('FILE_INVALID: image file missing.');

		const ext = kind === 'image' ? 'img' : 'mp4';
		const dest = jobPath(job_id, 'assets', `${shot_id}.${ext}`);
		fs.renameSync(tempPath, dest);

		res.json({ status: 'STORED', job_id, shot_id, kind, request_id: requestId });

	} catch (err) {
		logEvent(requestId, `STORE_FAILURE: ${err.message}`);
		res.status(500).json({ error: `STORE_FAILURE: ${err.message}`, request_id: requestId });
	}
});

// ============================================================
// ENDPOINT: POST /assemble
// Per shot: conform visual to audio duration, mux narration audio
// (strip original audio), burn that shot's subtitle (local-time,
// no offset math needed). Then concat all shots (already uniform
// codec/res/fps -> safe to -c copy concat). Narration audio only;
// image assets auto-converted to static video of correct duration.
// ============================================================
app.post('/assemble', requireApiSecret, async (req, res) => {
	const requestId = crypto.randomBytes(4).toString('hex');
	const { job_id, shot_ids } = req.body;

	if (!job_id || !Array.isArray(shot_ids) || shot_ids.length === 0) {
		return res.status(400).json({ error: 'VALIDATION_ERROR: "job_id" and non-empty "shot_ids" array (in final order) are required.', request_id: requestId });
	}
	if (!assembleGate.tryEnter()) return busyResponse(res, requestId, 30);

	const finalPath = jobPath(job_id, 'final', `${job_id}.mp4`);

	try {
		ensureJobDirs(job_id);
		logEvent(requestId, `Assembling job ${job_id}: ${shot_ids.length} shots.`);

		for (const shotId of shot_ids) {
			const shotOut = jobPath(job_id, 'shots', `${shotId}.mp4`);
			const audioPath = jobPath(job_id, 'audio', `${shotId}.mp3`);
			const subtitlePath = jobPath(job_id, 'subtitles', `${shotId}.srt`);
			const videoAsset = jobPath(job_id, 'assets', `${shotId}.mp4`);
			const imageAsset = jobPath(job_id, 'assets', `${shotId}.img`);

			if (!fs.existsSync(audioPath)) throw new Error(`MISSING_AUDIO: shot ${shotId} has no narration audio stored.`);
			const targetDuration = await probeDuration(audioPath);

			const hasVideo = fs.existsSync(videoAsset);
			const hasImage = fs.existsSync(imageAsset);
			if (!hasVideo && !hasImage) throw new Error(`MISSING_VISUAL: shot ${shotId} has no visual asset stored.`);

			const normalizedVisual = shotOut + '.visual.mp4';
			const normFilter = `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease,pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2,fps=${TARGET_FPS},setsar=1`;

			if (hasImage) {
				await runFfmpeg((c) => c.input(imageAsset).loop(targetDuration).videoFilters(normFilter)
					.outputOptions(['-pix_fmt yuv420p']).duration(targetDuration).fps(TARGET_FPS).output(normalizedVisual), 60000, requestId);
			} else {
				const srcDuration = await probeDuration(videoAsset);
				if (srcDuration >= targetDuration) {
					await runFfmpeg((c) => c.input(videoAsset).videoFilters(normFilter).outputOptions(['-pix_fmt yuv420p', '-an'])
						.duration(targetDuration).fps(TARGET_FPS).output(normalizedVisual), 60000, requestId);
				} else {
					await runFfmpeg((c) => c.input(videoAsset).inputOptions(['-stream_loop -1']).videoFilters(normFilter)
						.outputOptions(['-pix_fmt yuv420p', '-an']).duration(targetDuration).fps(TARGET_FPS).output(normalizedVisual), 60000, requestId);
				}
			}

			let muxed = shotOut + '.muxed.mp4';
			await runFfmpeg((c) => c.input(normalizedVisual).input(audioPath)
				.outputOptions(['-map 0:v:0', '-map 1:a:0', '-c:v copy', '-c:a aac', '-shortest']).output(muxed), 60000, requestId);

			if (fs.existsSync(subtitlePath)) {
				const escapedSrt = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
				await runFfmpeg((c) => c.input(muxed).outputOptions([`-vf subtitles=${escapedSrt}`, '-c:a copy']).output(shotOut), 60000, requestId);
			} else {
				fs.renameSync(muxed, shotOut);
			}

			[normalizedVisual, muxed].forEach((p) => fs.unlink(p, () => {}));
			logEvent(requestId, `Shot ${shotId} normalized (${targetDuration.toFixed(1)}s).`);
		}

		const listPath = jobPath(job_id, 'temp', 'concat_list.txt');
		const listContent = shot_ids.map((id) => `file '${jobPath(job_id, 'shots', `${id}.mp4`).replace(/'/g, "'\\''")}'`).join('\n');
		fs.writeFileSync(listPath, listContent);

		await runFfmpeg((c) => c.input(listPath).inputOptions(['-f concat', '-safe 0']).outputOptions(['-c copy', '-movflags +faststart']).output(finalPath), 180000, requestId);

		logEvent(requestId, `Job ${job_id} assembled successfully.`);

		res.setHeader('Content-Type', 'video/mp4');
		const stream = fs.createReadStream(finalPath);
		stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
		stream.pipe(res);
		stream.on('close', () => cleanupJob(job_id));

	} catch (err) {
		logEvent(requestId, `ASSEMBLY_FAILURE: ${err.message}`);
		if (!res.headersSent) res.status(500).json({ error: `ASSEMBLY_FAILURE: ${err.message}`, request_id: requestId });
	} finally {
		assembleGate.leave();
	}
});

app.get('/health', (req, res) => {
	ffmpeg.getAvailableFormats((err) => {
		if (err) return res.status(503).json({ status: 'degraded', ffmpeg_available: false });
		res.json({ status: 'ok', render_active: renderGate.active, tts_active: ttsGate.active, assemble_active: assembleGate.active, time: new Date().toISOString() });
	});
});

const server = app.listen(PORT, () => console.log(`v8 render/assembly service on port ${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));

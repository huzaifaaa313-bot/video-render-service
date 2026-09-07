// ============================================================
// UNIVERSAL VIDEO RENDER MICROSERVICE — v2
// Handles Ken Burns pan/zoom and text motion graphics.
// Hardened for limited-RAM free-tier hosting: concurrency
// limiting, font-availability safety, graceful shutdown,
// and request tracing.
// ============================================================

const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.RENDER_API_SECRET;
const FONT_PATH = process.env.FONT_PATH || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

// ------------------------------------------------------------
// CONCURRENCY GUARD
// Free-tier hosting has ~512MB RAM. Each FFmpeg render can use
// 100-200MB. Running too many at once will crash the container.
// We cap concurrent renders and queue/reject beyond that,
// rather than letting the process silently OOM.
// ------------------------------------------------------------

const MAX_CONCURRENT_RENDERS = 2;
let activeRenders = 0;

function logEvent(requestId, message) {
	console.log(`[${new Date().toISOString()}] [${requestId}] ${message}`);
}

// ------------------------------------------------------------
// SECURITY: shared-secret check
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

function makeTempPath(requestId, extension) {
	const fileName = `render_${requestId}_${crypto.randomBytes(4).toString('hex')}.${extension}`;
	return path.join(os.tmpdir(), fileName);
}

async function downloadToFile(url, destPath, requestId) {
	const response = await axios({
		method: 'GET',
		url,
		responseType: 'stream',
		timeout: 30000,
		maxContentLength: 25 * 1024 * 1024 // 25MB safety ceiling for source images
	});

	await new Promise((resolve, reject) => {
		const writer = fs.createWriteStream(destPath);
		response.data.pipe(writer);
		writer.on('finish', resolve);
		writer.on('error', reject);
		response.data.on('error', reject);
	});

	logEvent(requestId, `Downloaded source asset to ${destPath}`);
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
	const inputPath = makeTempPath(requestId, 'jpg');
	await downloadToFile(imageUrl, inputPath, requestId);

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
			.on('end', () => {
				clearTimeout(timeoutHandle);
				resolve();
			})
			.on('error', (err) => {
				clearTimeout(timeoutHandle);
				reject(err);
			})
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

	// fontfile is REQUIRED — minimal Docker images have no fonts
	// installed by default, and drawtext fails silently or crashes
	// without an explicit, verified font path.
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
			.on('end', () => {
				clearTimeout(timeoutHandle);
				resolve();
			})
			.on('error', (err) => {
				clearTimeout(timeoutHandle);
				reject(err);
			})
			.run();
	});
}

// ------------------------------------------------------------
// MAIN ENDPOINT
// ------------------------------------------------------------

app.post('/render', requireApiSecret, async (req, res) => {
	const requestId = crypto.randomBytes(4).toString('hex');
	const { type } = req.body;

	logEvent(requestId, `Incoming render request, type="${type}"`);

	if (!type) {
		return res.status(400).json({ error: 'VALIDATION_ERROR: "type" is required (e.g. "kenburns" or "textmotion").', request_id: requestId });
	}

	if (activeRenders >= MAX_CONCURRENT_RENDERS) {
		logEvent(requestId, `REJECTED: at capacity (${activeRenders}/${MAX_CONCURRENT_RENDERS} active renders).`);
		return res.status(429).json({
			error: 'SERVER_BUSY: maximum concurrent renders reached. Retry in a few seconds.',
			request_id: requestId
		});
	}

	activeRenders++;
	const outputPath = makeTempPath(requestId, 'mp4');

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

		} else {
			return res.status(400).json({ error: `VALIDATION_ERROR: unknown render type "${type}". Supported: kenburns, textmotion.`, request_id: requestId });
		}

		if (!fs.existsSync(outputPath)) {
			throw new Error('RENDER_ERROR: output file was not created.');
		}

		logEvent(requestId, 'Render succeeded, streaming response.');

		res.setHeader('Content-Type', 'video/mp4');
		res.setHeader('x-request-id', requestId);
		const stream = fs.createReadStream(outputPath);
		stream.pipe(res);
		stream.on('close', () => cleanupFiles(requestId, outputPath));

	} catch (err) {
		cleanupFiles(requestId, outputPath);
		logEvent(requestId, `RENDER_FAILURE: ${err.message}`);
		res.status(500).json({ error: `RENDER_FAILURE: ${err.message}`, request_id: requestId });

	} finally {
		activeRenders--;
	}
});

// ------------------------------------------------------------
// HEALTH CHECK — verifies FFmpeg binary is actually reachable,
// not just that the HTTP server is up.
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
			active_renders: activeRenders,
			time: new Date().toISOString()
		});
	});
});

// ------------------------------------------------------------
// GRACEFUL SHUTDOWN — Render.com sends SIGTERM on redeploy or
// sleep; finishing in-flight renders instead of killing them
// abruptly avoids corrupted output files.
// ------------------------------------------------------------

const server = app.listen(PORT, () => {
	console.log(`Video render service listening on port ${PORT}`);
});

process.on('SIGTERM', () => {
	console.log('SIGTERM received, shutting down gracefully...');
	server.close(() => {
		console.log('Server closed.');
		process.exit(0);
	});
});

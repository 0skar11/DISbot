// removeBgWorker.js: the heavy part of `شيل الخلفية` (removeBgService.js), in a worker thread so the bot's event
// loop never waits on it. Gets picture bytes, answers a PNG with a transparent background.
//
// Steps (the rembg recipe for the U2-Net / IS-Net models): the picture is turned by its EXIF, downscaled to at
// most MAX_SIDE, resized to the model's square input, normalised, run through the ONNX model (onnxruntime-node,
// CPU), and the predicted mask, stretched back to the picture's size, becomes its alpha channel.
import { parentPort } from 'node:worker_threads';
import sharp from 'sharp';

const MAX_SIDE = 1500;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const OUTPUT_SIDES = [MAX_SIDE, 1000, 700];

let ort = null;
let session = null;
let sessionPath = null;

function fail(code, message) {
    const error = new Error(message || code);
    error.code = code;
    return error;
}

async function getSession(modelPath, threads) {
    if (session && sessionPath === modelPath) return session;
    try {
        ort ??= await import('onnxruntime-node');
    } catch (error) {
        throw fail('unavailable', `onnxruntime-node could not load: ${error.message}`);
    }
    session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        intraOpNumThreads: threads,
        interOpNumThreads: 1,
        graphOptimizationLevel: 'all',
    }).catch((error) => { throw fail('unavailable', `model could not load: ${error.message}`); });
    sessionPath = modelPath;
    return session;
}

/** The model's mask for an RGB picture (width x height x 3 bytes), as width x height bytes (0 = background). */
async function predictMask(rgb, width, height, model, modelPath, threads) {
    const side = model.size;
    const small = await sharp(rgb, { raw: { width, height, channels: 3 } })
        .resize(side, side, { fit: 'fill', kernel: 'lanczos3' })
        .raw()
        .toBuffer();
    let max = 1;
    for (const value of small) if (value > max) max = value;
    const area = side * side;
    const input = new Float32Array(3 * area);
    for (let i = 0; i < area; i += 1) {
        for (let c = 0; c < 3; c += 1) input[c * area + i] = (small[i * 3 + c] / max - model.mean[c]) / model.std[c];
    }
    const current = await getSession(modelPath, threads);
    const output = await current.run({ [current.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, side, side]) });
    const prediction = output[current.outputNames[0]].data;
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i < area; i += 1) {
        if (prediction[i] < low) low = prediction[i];
        if (prediction[i] > high) high = prediction[i];
    }
    const range = high - low || 1;
    const mask = Buffer.alloc(area);
    for (let i = 0; i < area; i += 1) mask[i] = Math.round(((prediction[i] - low) / range) * 255);
    return sharp(mask, { raw: { width: side, height: side, channels: 1 } })
        .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
        // sharp hands a resized 1-channel raw image back with 3 channels: keep one, or the alpha (joinChannel) is read
        // with the wrong stride and the picture comes out as horizontal stripes.
        .extractChannel(0)
        .raw()
        .toBuffer();
}

export async function removeBackgroundInWorker({ input, model, modelPath, threads = 2 }) {
    let picture;
    try {
        picture = await sharp(Buffer.from(input), { limitInputPixels: 40_000_000 })
            .rotate()
            .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
    } catch (error) {
        throw fail('not image', error.message);
    }
    const { data, info } = picture;
    const mask = await predictMask(data, info.width, info.height, model, modelPath, threads);
    const rgba = sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } })
        .joinChannel(mask, { raw: { width: info.width, height: info.height, channels: 1 } });
    const full = await rgba.png().toBuffer();
    if (full.length <= MAX_OUTPUT_BYTES) return full;
    for (const side of OUTPUT_SIDES.slice(1)) {
        const smaller = await sharp(full).resize({ width: side, height: side, fit: 'inside' }).png().toBuffer();
        if (smaller.length <= MAX_OUTPUT_BYTES) return smaller;
    }
    throw fail('too big');
}

parentPort?.on('message', async (job) => {
    try {
        const png = await removeBackgroundInWorker(job);
        const bytes = new Uint8Array(png.buffer, png.byteOffset, png.length).slice();
        parentPort.postMessage({ id: job.id, ok: true, png: bytes }, [bytes.buffer]);
    } catch (error) {
        parentPort.postMessage({ id: job.id, ok: false, code: error.code || 'failed', error: error.message });
    }
});

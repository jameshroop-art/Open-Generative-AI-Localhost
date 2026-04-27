"""Python sidecar server for Open Generative AI.

Provides HTTP endpoints for Python-only AI features:
  GET  /health                  — liveness check
  POST /esrgan/upscale          — RealESRGAN super-resolution
  POST /gfpgan/restore          — GFPGAN face restoration
  POST /insightface/swap        — InsightFace face swap
  POST /diffusers/generate      — HuggingFace Diffusers image generation
  POST /cogvideox/generate      — CogVideoX local video generation (T2V + I2V)

All image endpoints accept and return base64-encoded PNG data via JSON.
The /cogvideox/generate endpoint returns base64-encoded MP4 video.
The server starts on 127.0.0.1 only and is never exposed to the network.
"""

import io
import os
import sys
import base64
import logging

from flask import Flask, request, jsonify
from flask_cors import CORS

logging.basicConfig(
    level=logging.INFO,
    format="[python-server] %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger(__name__)

app = Flask(__name__)
# Restrict CORS to localhost origins — this server is only ever called from the
# local Next.js proxy, never from remote websites.
CORS(app, resources={r'/*': {'origins': [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173',
]}})

# ── Lazy-loaded model caches ──────────────────────────────────────────────────
_esrgan_models = {}   # model_name → RealESRGANer instance
_gfpgan_model = None
_cogvideox_pipes = {}  # (model_path, is_i2v) → loaded pipeline instance


def _decode_image(b64_string):
    """Decode a base64 string into a PIL Image."""
    from PIL import Image
    data = base64.b64decode(b64_string)
    return Image.open(io.BytesIO(data))


def _encode_image(img, fmt="PNG"):
    """Encode a PIL Image to a base64 string."""
    buf = io.BytesIO()
    img.save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode()


# ── Health ────────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return jsonify({"status": "ok"})


# ── ESRGAN ────────────────────────────────────────────────────────────────────
@app.post("/esrgan/upscale")
def esrgan_upscale():
    """Upscale an image using RealESRGAN.

    Request JSON:
      image   str   base64-encoded input image (required)
      scale   int   upscale factor, 2 or 4 (default 4)
      model   str   model filename without .pth (default RealESRGAN_x4plus)
    Response JSON:
      image   str   base64-encoded upscaled PNG
    """
    global _esrgan_models
    try:
        from basicsr.archs.rrdbnet_arch import RRDBNet
        from realesrgan import RealESRGANer
    except ImportError as exc:
        return jsonify({"error": f"realesrgan not installed: {exc}"}), 503

    body = request.get_json(force=True)
    if not body or "image" not in body:
        return jsonify({"error": "Missing required field: image"}), 400

    scale = int(body.get("scale", 4))
    model_name = body.get("model", "RealESRGAN_x4plus")

    models_dir = os.environ.get(
        "ESRGAN_MODELS_DIR",
        os.path.join(os.path.dirname(__file__), "..", "esrgan_models"),
    )
    model_path = os.path.join(models_dir, f"{model_name}.pth")

    if not os.path.exists(model_path):
        return jsonify({"error": f"Model not found: {model_path}"}), 404

    if model_name not in _esrgan_models:
        net = RRDBNet(
            num_in_ch=3,
            num_out_ch=3,
            num_feat=64,
            num_block=23,
            num_grow_ch=32,
            scale=scale,
        )
        _esrgan_models[model_name] = RealESRGANer(
            scale=scale,
            model_path=model_path,
            model=net,
            tile=0,
            tile_pad=10,
            pre_pad=0,
            half=False,
        )

    import numpy as np
    from PIL import Image

    img = _decode_image(body["image"])
    img_array = np.array(img.convert("RGB"))
    output, _ = _esrgan_models[model_name].enhance(img_array, outscale=scale)
    return jsonify({"image": _encode_image(Image.fromarray(output))})


# ── GFPGAN ────────────────────────────────────────────────────────────────────
@app.post("/gfpgan/restore")
def gfpgan_restore():
    """Restore faces in an image using GFPGAN.

    Request JSON:
      image    str    base64-encoded input image (required)
      weight   float  fidelity weight 0-1 (default 0.5)
    Response JSON:
      image   str    base64-encoded restored PNG
    """
    global _gfpgan_model
    try:
        from gfpgan import GFPGANer
    except ImportError as exc:
        return jsonify({"error": f"gfpgan not installed: {exc}"}), 503

    body = request.get_json(force=True)
    if not body or "image" not in body:
        return jsonify({"error": "Missing required field: image"}), 400

    weight = float(body.get("weight", 0.5))

    weights_dir = os.environ.get(
        "GFPGAN_WEIGHTS_DIR",
        os.path.join(os.path.dirname(__file__), "..", "gfpgan"),
    )
    model_path = os.path.join(weights_dir, "GFPGANv1.4.pth")

    if not os.path.exists(model_path):
        return jsonify({
            "error": (
                f"GFPGAN weights not found at {model_path}. "
                "Download GFPGANv1.4.pth into the gfpgan/ directory."
            )
        }), 404

    if _gfpgan_model is None:
        _gfpgan_model = GFPGANer(
            model_path=model_path,
            upscale=1,
            arch="clean",
            channel_multiplier=2,
        )

    import numpy as np
    from PIL import Image

    img = _decode_image(body["image"])
    # GFPGAN expects BGR
    img_bgr = np.array(img.convert("RGB"))[:, :, ::-1]
    _, _, restored_bgr = _gfpgan_model.enhance(
        img_bgr,
        has_aligned=False,
        only_center_face=False,
        paste_back=True,
        weight=weight,
    )
    result = Image.fromarray(restored_bgr[:, :, ::-1])  # BGR → RGB
    return jsonify({"image": _encode_image(result)})


# ── InsightFace swap ──────────────────────────────────────────────────────────
@app.post("/insightface/swap")
def insightface_swap():
    """Swap the face from source onto every face in target.

    Request JSON:
      source  str  base64-encoded source face image (required)
      target  str  base64-encoded target image (required)
    Response JSON:
      image   str  base64-encoded result PNG
    """
    try:
        import insightface
        from insightface.app import FaceAnalysis
    except ImportError as exc:
        return jsonify({"error": f"insightface not installed: {exc}"}), 503

    body = request.get_json(force=True)
    if not body or "source" not in body or "target" not in body:
        return jsonify({"error": "Missing required fields: source, target"}), 400

    import numpy as np
    from PIL import Image

    models_dir = os.environ.get(
        "INSIGHTFACE_MODELS_DIR",
        os.path.join(os.path.dirname(__file__), "..", "extensions", "insightface", "models"),
    )

    face_app = FaceAnalysis(
        name="buffalo_l",
        providers=["CPUExecutionProvider"],
        root=models_dir,
    )
    face_app.prepare(ctx_id=0, det_size=(640, 640))

    swapper_path = os.path.join(models_dir, "inswapper_128.onnx")
    if not os.path.exists(swapper_path):
        return jsonify({
            "error": f"Swap model not found: {swapper_path}. Download inswapper_128.onnx into extensions/insightface/models/."
        }), 404

    swapper = insightface.model_zoo.get_model(
        swapper_path, providers=["CPUExecutionProvider"]
    )

    src_bgr = np.array(_decode_image(body["source"]).convert("RGB"))[:, :, ::-1]
    tgt_bgr = np.array(_decode_image(body["target"]).convert("RGB"))[:, :, ::-1]

    src_faces = face_app.get(src_bgr)
    tgt_faces = face_app.get(tgt_bgr)

    if not src_faces:
        return jsonify({"error": "No face detected in source image"}), 422
    if not tgt_faces:
        return jsonify({"error": "No face detected in target image"}), 422

    result = tgt_bgr.copy()
    for face in tgt_faces:
        result = swapper.get(result, face, src_faces[0], paste_back=True)

    out = Image.fromarray(result[:, :, ::-1])  # BGR → RGB
    return jsonify({"image": _encode_image(out)})


# ── Diffusers generate ────────────────────────────────────────────────────────
@app.post("/diffusers/generate")
def diffusers_generate():
    """Generate an image from a local HuggingFace Diffusers model directory.

    Request JSON:
      model_path       str    path to local diffusers model directory (required)
      prompt           str    positive prompt
      negative_prompt  str    negative prompt (optional)
      width            int    output width (default 512)
      height           int    output height (default 512)
      steps            int    inference steps (default 20)
      guidance         float  CFG scale (default 7.5)
      seed             int    RNG seed (optional)
    Response JSON:
      image  str  base64-encoded generated PNG
    """
    try:
        import torch
        from diffusers import DiffusionPipeline
    except ImportError as exc:
        return jsonify({"error": f"torch/diffusers not installed: {exc}"}), 503

    body = request.get_json(force=True)
    if not body:
        return jsonify({"error": "JSON body required"}), 400

    model_path = body.get("model_path")
    if not model_path or not os.path.isdir(model_path):
        return jsonify({"error": "model_path must point to a local diffusers directory"}), 400

    if torch.cuda.is_available():
        device, dtype = "cuda", torch.float16
    elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        device, dtype = "mps", torch.float16
    else:
        device, dtype = "cpu", torch.float32

    pipe = DiffusionPipeline.from_pretrained(model_path, torch_dtype=dtype)
    pipe = pipe.to(device)

    # ── LoRA support ──────────────────────────────────────────────────────────
    lora_path = body.get("lora_path")
    lora_weight = float(body.get("lora_weight", 1.0))
    if lora_path:
        if os.path.isfile(lora_path):
            log.info("Loading LoRA weights from %s (weight=%.2f)", lora_path, lora_weight)
            try:
                pipe.load_lora_weights(
                    os.path.dirname(lora_path),
                    weight_name=os.path.basename(lora_path),
                    adapter_name="custom",
                )
                pipe.set_adapters(["custom"], adapter_weights=[lora_weight])
            except Exception as exc:
                log.warning("Failed to load LoRA weights: %s", exc)
        else:
            log.warning("LoRA file not found, skipping: %s", lora_path)

    generator = torch.Generator(device=device)
    if body.get("seed") is not None:
        generator.manual_seed(int(body["seed"]))

    result = pipe(
        prompt=body.get("prompt", ""),
        negative_prompt=body.get("negative_prompt") or None,
        width=int(body.get("width", 512)),
        height=int(body.get("height", 512)),
        num_inference_steps=int(body.get("steps", 20)),
        guidance_scale=float(body.get("guidance", 7.5)),
        generator=generator,
    )

    return jsonify({"image": _encode_image(result.images[0])})


# ── CogVideoX video generation ────────────────────────────────────────────────
@app.post("/cogvideox/generate")
def cogvideox_generate():
    """Generate a video using a local CogVideoX model.

    Request JSON:
      model_path       str    absolute path to local CogVideoX model directory (required)
      prompt           str    text prompt (required)
      image            str    base64-encoded input image for image-to-video (optional)
      num_frames       int    number of frames to generate (default 49 ≈ 6 s @ 8 fps)
      guidance_scale   float  classifier-free guidance scale (default 6.0)
      steps            int    inference steps (default 50)
      seed             int    RNG seed (optional)
      lora_path        str    absolute path to a LoRA .safetensors file (optional)
      lora_weight      float  LoRA adapter weight 0-1 (default 1.0)
      fps              int    frames-per-second for the output MP4 (default 8)
    Response JSON:
      video  str  base64-encoded MP4 video
    """
    global _cogvideox_pipes
    try:
        import torch
        from diffusers import CogVideoXPipeline, CogVideoXImageToVideoPipeline
        from diffusers.utils import export_to_video
    except ImportError as exc:
        return jsonify({"error": f"torch/diffusers not installed: {exc}"}), 503

    body = request.get_json(force=True)
    if not body:
        return jsonify({"error": "JSON body required"}), 400

    model_path = body.get("model_path")
    if not model_path:
        # Try the environment default, then fall back to CogVideoX/ next to repo root
        model_path = os.environ.get(
            "COGVIDEOX_MODEL_PATH",
            os.path.join(os.path.dirname(__file__), "..", "CogVideoX", "CogVideoX-5b"),
        )
    if not os.path.isdir(model_path):
        return jsonify({"error": f"model_path must point to a local CogVideoX directory: {model_path}"}), 400

    prompt = body.get("prompt", "")
    num_frames = int(body.get("num_frames", 49))
    guidance_scale = float(body.get("guidance_scale", 6.0))
    steps = int(body.get("steps", 50))
    fps = int(body.get("fps", 8))

    if torch.cuda.is_available():
        device, dtype = "cuda", torch.bfloat16
    elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        device, dtype = "mps", torch.float16
    else:
        device, dtype = "cpu", torch.float32

    # Choose pipeline based on whether an input image was supplied; cache by (path, type).
    image_b64 = body.get("image")
    is_i2v = bool(image_b64)
    cache_key = (model_path, is_i2v)

    if cache_key not in _cogvideox_pipes:
        if is_i2v:
            log.info("CogVideoX: loading I2V pipeline from %s", model_path)
            pipe = CogVideoXImageToVideoPipeline.from_pretrained(model_path, torch_dtype=dtype)
        else:
            log.info("CogVideoX: loading T2V pipeline from %s", model_path)
            pipe = CogVideoXPipeline.from_pretrained(model_path, torch_dtype=dtype)
        _cogvideox_pipes[cache_key] = pipe.to(device)
        log.info("CogVideoX: pipeline loaded and cached (%s)", cache_key)
    else:
        log.info("CogVideoX: using cached pipeline (%s)", cache_key)

    pipe = _cogvideox_pipes[cache_key]

    # Optional LoRA
    lora_path = body.get("lora_path")
    lora_weight = float(body.get("lora_weight", 1.0))
    if lora_path:
        if os.path.isfile(lora_path):
            log.info("CogVideoX: loading LoRA from %s (weight=%.2f)", lora_path, lora_weight)
            try:
                pipe.load_lora_weights(
                    os.path.dirname(lora_path),
                    weight_name=os.path.basename(lora_path),
                    adapter_name="custom",
                )
                pipe.set_adapters(["custom"], adapter_weights=[lora_weight])
            except Exception as exc:
                log.warning("CogVideoX: failed to load LoRA weights: %s", exc)
        else:
            log.warning("CogVideoX: LoRA file not found, skipping: %s", lora_path)

    generator = torch.Generator(device=device)
    if body.get("seed") is not None:
        generator.manual_seed(int(body["seed"]))

    try:
        if image_b64:
            from PIL import Image as PilImage
            img = _decode_image(image_b64).convert("RGB")
            # CogVideoX I2V expects 480×720 (height×width) by default; resize if needed
            img = img.resize((720, 480))
            video_frames = pipe(
                prompt=prompt,
                image=img,
                num_frames=num_frames,
                guidance_scale=guidance_scale,
                num_inference_steps=steps,
                generator=generator,
            ).frames[0]
        else:
            video_frames = pipe(
                prompt=prompt,
                num_frames=num_frames,
                guidance_scale=guidance_scale,
                num_inference_steps=steps,
                generator=generator,
            ).frames[0]
    except Exception as exc:
        log.error("CogVideoX generation failed: %s", exc)
        return jsonify({"error": f"CogVideoX generation failed: {exc}"}), 500

    # Export frames to MP4 in a temp file, then return base64
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        export_to_video(video_frames, tmp_path, fps=fps)
        with open(tmp_path, "rb") as fh:
            video_b64 = base64.b64encode(fh.read()).decode()
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    return jsonify({"video": video_b64})


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    port = int(os.environ.get("PYTHON_SERVER_PORT", 7861))
    log.info("Starting Python sidecar on 127.0.0.1:%d", port)
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)

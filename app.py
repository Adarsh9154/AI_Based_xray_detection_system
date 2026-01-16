
import os
import traceback
import logging
import time
from datetime import datetime
from io import BytesIO
from PIL import Image

from flask import Flask, request, jsonify, render_template, send_file
from werkzeug.utils import secure_filename

# SQLAlchemy imports
from sqlalchemy import create_engine, Column, Integer, String, Float, DateTime, func, TIMESTAMP
from sqlalchemy.orm import sessionmaker, declarative_base
from sqlalchemy.exc import SQLAlchemyError

# Optional: TensorFlow (if installed)
try:
    from tensorflow.keras.models import load_model
    from tensorflow.keras.preprocessing import image
    import numpy as np
    TF_AVAILABLE = True
except Exception:
    TF_AVAILABLE = False

# PDF generation
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

# ---------------- CONFIG ----------------
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
TEMPLATES = os.path.join(PROJECT_ROOT, "templates")
STATIC = os.path.join(PROJECT_ROOT, "static")
UPLOAD_DIR = os.path.join(STATIC, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

MODEL_PATH = r"final_code.h5"  
IMG_TARGET_SIZE = (150, 150)
ALLOWED_EXT = {"png", "jpg", "jpeg", "gif", "webp"}

# ---------- MySQL (Option 1: Hardcoded, no fallback) ----------
DB_USER = "xray_user"
DB_PASSWORD = "root"             # <-- set your password here
DB_HOST = "127.0.0.1"
DB_PORT = 3306
DB_NAME = "xray_db"

DATABASE_URL = f"mysql+pymysql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}?charset=utf8mb4"
print("Using MySQL database:", DATABASE_URL)

# ---------- Flask app ----------
app = Flask(__name__, static_folder=STATIC, template_folder=TEMPLATES)

# ---------- Logging ----------
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ---------- SQLAlchemy setup ----------
engine = create_engine(DATABASE_URL, pool_pre_ping=True, pool_size=5, max_overflow=10, pool_recycle=3600, echo=False)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)
Base = declarative_base()

class Prediction(Base):
    __tablename__ = "predictions"
    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    scan_id = Column(String(64), unique=True, index=True, nullable=False)
    patient_name = Column(String(255))
    label = Column(String(64))
    confidence = Column(Float)
    inference_time = Column(Float)
    image_path = Column(String(512))
    # Use TIMESTAMP with server_default CURRENT_TIMESTAMP — compatible with MySQL 5.5
    timestamp = Column(TIMESTAMP, server_default=func.current_timestamp(), nullable=False)
    true_label = Column(String(64), nullable=True)

# Create tables (for simple setups; in production use migrations)
Base.metadata.create_all(bind=engine)

# ---------- DB helper functions ----------
def insert_prediction(scan_id, patient_name, label, confidence, inference_time, image_path):
    session = SessionLocal()
    try:
        obj = session.query(Prediction).filter_by(scan_id=scan_id).one_or_none()
        if obj:
            obj.patient_name = patient_name
            obj.label = label
            obj.confidence = float(confidence)
            obj.inference_time = float(inference_time)
            obj.image_path = image_path
            obj.timestamp = datetime.utcnow()
        else:
            obj = Prediction(
                scan_id=scan_id,
                patient_name=patient_name,
                label=label,
                confidence=float(confidence),
                inference_time=float(inference_time),
                image_path=image_path
            )
            session.add(obj)
        session.commit()
    except SQLAlchemyError:
        session.rollback()
        logger.exception("insert_prediction error")
        raise
    finally:
        session.close()

def query_stats():
    session = SessionLocal()
    try:
        total = session.query(func.count(Prediction.id)).scalar() or 0
        fractured = session.query(func.count(Prediction.id)).filter(Prediction.label == "Fractured").scalar() or 0
        avg_latency = session.query(func.avg(Prediction.inference_time)).scalar()
        labelled = session.query(func.count(Prediction.id)).filter(Prediction.true_label != None).scalar() or 0
        model_accuracy = None
        if labelled > 0:
            correct_avg = session.query(func.avg(func.case([(Prediction.label == Prediction.true_label, 1.0)], else_=0.0))).filter(Prediction.true_label != None).scalar()
            if correct_avg is not None:
                model_accuracy = float(correct_avg) * 100.0
        return {
            "total_scans": int(total),
            "fractures": int(fractured),
            "avg_latency": float(avg_latency) if avg_latency is not None else None,
            "model_accuracy": round(model_accuracy, 2) if model_accuracy is not None else None,
            "labelled_count": int(labelled)
        }
    finally:
        session.close()

def query_recent(limit=10):
    session = SessionLocal()
    try:
        rows = session.query(Prediction).order_by(Prediction.id.desc()).limit(limit).all()
        out = []
        for r in rows:
            out.append({
                "scan_id": r.scan_id,
                "patient_name": r.patient_name,
                "label": r.label,
                "confidence": r.confidence,
                "inference_time": r.inference_time,
                "image_path": r.image_path,
                "timestamp": r.timestamp.isoformat() if r.timestamp is not None else None
            })
        return out
    finally:
        session.close()

# ---------- Optional model loading ----------
model = None
if TF_AVAILABLE:
    try:
        if os.path.exists(MODEL_PATH):
            model = load_model(MODEL_PATH)
            logger.info("Model loaded from %s", MODEL_PATH)
        else:
            logger.warning("MODEL_PATH not found: %s. Running in demo mode.", MODEL_PATH)
    except Exception:
        logger.exception("Failed to load model; running in demo mode.")
else:
    logger.info("TensorFlow not available; running in demo mode.")

# ---------- Helpers ----------
def allowed_file(filename):
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return ext in ALLOWED_EXT

def request_wants_json():
    accept = request.headers.get("Accept", "")
    xrw = request.headers.get("X-Requested-With", "")
    return "application/json" in accept or xrw == "XMLHttpRequest"

def preprocess_image(filepath):
    img = image.load_img(filepath, target_size=IMG_TARGET_SIZE)
    arr = image.img_to_array(img) / 255.0
    arr = np.expand_dims(arr, axis=0)
    return arr

def predict_from_model(input_data):
    if model is None:
        import random
        return random.uniform(0.75, 0.95)
    preds = model.predict(input_data)
    val = float(np.asarray(preds).flatten()[0])
    return val

# ---------- Routes ----------
@app.route("/")
def index():
    return render_template("dashboard.html")

@app.route("/predict", methods=["POST"])
def predict():
    try:
        # validate file presence
        if "file" not in request.files:
            msg = "No file uploaded"
            if request_wants_json():
                return jsonify({"error": msg}), 400
            return render_template("dashboard.html", error=msg)

        file = request.files["file"]
        if file.filename == "":
            msg = "No file selected"
            if request_wants_json():
                return jsonify({"error": msg}), 400
            return render_template("dashboard.html", error=msg)

        # patient name (required)
        patient_name = request.form.get("patient_name", "")
        if patient_name is None:
            patient_name = ""
        patient_name = patient_name.strip()
        if not patient_name:
            msg = "Patient name is required."
            logger.info("Rejecting upload: missing patient name.")
            if request_wants_json():
                return jsonify({"error": msg}), 400
            return render_template("dashboard.html", error=msg)

        if not allowed_file(file.filename):
            msg = "File type not allowed"
            if request_wants_json():
                return jsonify({"error": msg}), 400
            return render_template("dashboard.html", error=msg)

        filename = secure_filename(file.filename)
        ts = datetime.now().strftime("%Y%m%d%H%M%S%f")
        saved_name = f"{ts}_{filename}"
        filepath = os.path.join(UPLOAD_DIR, saved_name)
        file.save(filepath)

        # WEBP -> PNG conversion
        ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
        if ext == "webp":
            try:
                im = Image.open(filepath).convert("RGB")
                base_without_ext = saved_name.rsplit(".", 1)[0]
                new_name = f"{base_without_ext}.png"
                new_path = os.path.join(UPLOAD_DIR, new_name)
                im.save(new_path, "PNG")
                try:
                    os.remove(filepath)
                except Exception:
                    pass
                saved_name = new_name
                filepath = new_path
                logger.info("Converted WEBP to PNG: %s", new_path)
            except Exception as e:
                logger.exception("WEBP conversion error: %s", e)
                if request_wants_json():
                    return jsonify({"error": "WEBP conversion failed", "details": str(e)}), 400
                return render_template("dashboard.html", error="WEBP conversion failed: " + str(e))

        # predict and measure inference time
        inference_time = 0.0
        if TF_AVAILABLE and model is not None:
            try:
                input_data = preprocess_image(filepath)
                t0 = time.time()
                prob = predict_from_model(input_data)
                t1 = time.time()
                inference_time = round(t1 - t0, 4)
            except Exception as e:
                logger.exception("Model prediction error: %s", e)
                if request_wants_json():
                    return jsonify({"error": "Prediction error", "details": str(e)}), 500
                return render_template("dashboard.html", error="Prediction error: " + str(e))
        else:
            t0 = time.time()
            prob = predict_from_model(None)
            t1 = time.time()
            inference_time = round(t1 - t0, 4)

        # mapping label
        label = "Normal" if prob > 0.5 else "Fractured"
        confidence = float(prob if label == "Normal" else 1.0 - prob)
        confidence_pct = round(confidence * 100.0, 2)
        scan_id = f"A{datetime.now().strftime('%y%m%d%H%M%S')}"

        # persist to MySQL
        try:
            insert_prediction(scan_id, patient_name, label, confidence, inference_time, f"/static/uploads/{saved_name}")
        except Exception:
            logger.exception("DB insert failed")

        if request_wants_json():
            return jsonify({
                "id": scan_id,
                "label": label,
                "confidence": confidence,
                "confidence_pct": confidence_pct,
                "image_path": f"/static/uploads/{saved_name}",
                "patient_name": patient_name,
                "inference_time": inference_time
            })

        # HTML fallback
        current_date = datetime.now().strftime("%B %d, %Y")
        doctor_note = "Please consult your physician if symptoms persist."
        return render_template('result.html',
                               prediction=label,
                               accuracy=confidence_pct,
                               image_path=f"/static/uploads/{saved_name}",
                               doctor_note=doctor_note,
                               current_date=current_date,
                               patient_name=patient_name)

    except Exception as e:
        tb = traceback.format_exc()
        logger.error("Unhandled error in /predict: %s\n%s", e, tb)
        if request_wants_json():
            return jsonify({"error": "Unhandled server error", "details": str(e)}), 500
        return render_template("dashboard.html", error="Unhandled server error: " + str(e))


# API endpoints for dashboard
@app.route("/api/stats")
def api_stats():
    try:
        stats = query_stats()
        return jsonify(stats)
    except Exception:
        logger.exception("Failed to fetch stats")
        return jsonify({"error": "Failed to fetch stats"}), 500

@app.route("/api/recent")
def api_recent():
    try:
        n = int(request.args.get("n", 10))
        rows = query_recent(n)
        return jsonify({"recent": rows})
    except Exception:
        logger.exception("Failed to fetch recent rows")
        return jsonify({"error": "Failed to fetch recent rows"}), 500


# Download report (GET or POST)
@app.route("/download_report", methods=["GET", "POST"])
def download_report():
    data = request.form if request.method == "POST" else request.args
    prediction = data.get("prediction", "Unknown")
    accuracy = data.get("accuracy", "N/A")
    image_path = data.get("image_path", None)
    patient_name = data.get("patient_name", "Uploaded Patient")
    current_date = data.get("current_date", datetime.now().strftime("%B %d, %Y"))

    buffer = BytesIO()
    c = canvas.Canvas(buffer, pagesize=(595, 842))
    c.setFont("Helvetica-Bold", 20)
    c.drawString(40, 800, "X-ray Analysis Report")

    c.setFont("Helvetica", 12)
    c.drawString(40, 780, f"Date: {current_date}")
    c.drawString(40, 760, f"Patient: {patient_name}")
    c.drawString(40, 740, f"Diagnosis: {prediction}")
    c.drawString(40, 720, f"Confidence: {accuracy}%")

    use_path = None
    if image_path:
        candidate = image_path.lstrip("/")
        candidate2 = os.path.join(UPLOAD_DIR, os.path.basename(candidate))
        if os.path.exists(candidate):
            use_path = candidate
        elif os.path.exists(candidate2):
            use_path = candidate2

    if use_path:
        try:
            c.drawImage(ImageReader(use_path), 40, 380, width=300, height=300)
        except Exception:
            logger.warning("Could not embed image into PDF")

    c.drawString(40, 360, "Doctor's Note:")
    c.setFont("Helvetica-Oblique", 12)
    c.drawString(60, 340, "Always consult a medical professional if you have any concerns.")
    c.showPage()
    c.save()
    buffer.seek(0)
    return send_file(buffer, as_attachment=True, download_name="xray_report.pdf", mimetype="application/pdf")


# ---------- Run ----------
if __name__ == "__main__":
    # quick DB connectivity test on startup (helpful)
    try:
        conn = engine.connect()
        conn.close()
        print("MySQL connection OK")
    except Exception as e:
        print("ERROR connecting to MySQL:", e)
        raise

    # Run Flask
    app.run(debug=True, host="0.0.0.0", port=5000)
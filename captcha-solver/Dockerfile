# Captcha solver — Flask + ddddocr (slider) + OpenCV (rotation). Reached by the
# TikTok and XHS scrapers over the compose network at http://captcha-solver:5001.
FROM python:3.11-slim

WORKDIR /app

# OpenCV runtime shared libs (opencv-python wheels need these present).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 5001
CMD ["python", "solver.py"]

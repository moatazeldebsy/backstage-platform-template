FROM python:3.13-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ ./src/

# Model artifacts are loaded at runtime from MLflow or a mounted volume
ENV PYTHONUNBUFFERED=1
ENV MODEL_FRAMEWORK=${{ values.modelFramework }}

EXPOSE ${{ values.port }}

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "${{ values.port }}"]

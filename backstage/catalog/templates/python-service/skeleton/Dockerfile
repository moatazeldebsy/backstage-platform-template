FROM python:3.13-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ ./src/

# Run as non-root (Trivy DS-0002 / container hardening)
RUN useradd --create-home --uid 10001 appuser
USER appuser

EXPOSE ${{ values.port }}

ENV PYTHONUNBUFFERED=1

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "${{ values.port }}"]

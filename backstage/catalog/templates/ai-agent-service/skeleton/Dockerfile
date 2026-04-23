FROM python:3.13-slim

# Non-root user — required for Kubernetes restricted Pod Security Standards
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ ./src/

ENV PYTHONUNBUFFERED=1
ENV LLM_PROVIDER=${{ values.llmProvider }}
ENV LLM_MODEL=${{ values.llmModel }}

# Drop privileges before starting the server
USER appuser

EXPOSE ${{ values.port }}

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "${{ values.port }}"]

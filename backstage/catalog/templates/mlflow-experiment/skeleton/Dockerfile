FROM python:${{ values.pythonVersion }}-slim
WORKDIR /app
RUN addgroup --system ml && adduser --system --ingroup ml ml
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY train.py ./
USER ml
CMD ["python", "train.py"]

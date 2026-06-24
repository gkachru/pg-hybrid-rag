FROM python:3.11-slim

WORKDIR /app

# Install a CPU-only torch FIRST, from the PyTorch CPU index, so the subsequent `attacut`
# install (which depends on torch) sees it already satisfied and does NOT pull the multi-GB
# CUDA wheel from the default index. Then install the rest of the pinned deps.
RUN pip install --no-cache-dir torch==2.2.2 --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]

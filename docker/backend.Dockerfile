FROM python:3.12-slim-bookworm

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .

COPY docker/entrypoint-backend.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

RUN groupadd -g 1000 quickscope && useradd -u 1000 -g quickscope -m -s /bin/bash quickscope \
    && mkdir -p /data && chown -R quickscope:quickscope /data /app

ENV QUICKSCOPE_DATA_DIR=/data
ENV QUICKSCOPE_PARSER=libxrk

USER quickscope

EXPOSE 8000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]

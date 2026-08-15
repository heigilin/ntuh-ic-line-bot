FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py knowledge_search.py ./
COPY output/coze_upload ./output/coze_upload

ENV HOST=0.0.0.0
ENV PORT=8000
ENV KNOWLEDGE_DIR=output/coze_upload

EXPOSE 8000

CMD ["python", "app.py"]

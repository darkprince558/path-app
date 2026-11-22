# Internal path-gemini service for Sam's backend (not for the public internet).
#
#   docker build -t path-gemini services/gemini
#   docker run --rm --env-file services/gemini/.env -e GEMINI_SERVICE_TOKEN=... \
#     --network <backend-network> --name path-gemini path-gemini
#
# The backend then calls http://path-gemini:8090. Do not publish the port
# publicly. Secrets come from the environment, never from the image.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    GEMINI_SERVICE_HOST=0.0.0.0 GEMINI_SERVICE_PORT=8090

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install --no-cache-dir . && useradd --system --no-create-home pathgemini

USER pathgemini
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8090/healthz', timeout=4).status == 200 else 1)"
CMD ["python", "-m", "path_gemini.server"]

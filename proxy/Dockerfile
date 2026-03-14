FROM python:3.12-slim

WORKDIR /app

# mitmproxy includes mitmdump
RUN pip install --no-cache-dir mitmproxy==10.4.2

COPY addon.py .

# 8080 — reverse proxy to api.anthropic.com (sub-agents connect here)
# 8081 — stats HTTP endpoint (orchestrator queries this)
EXPOSE 8080 8081

# -q suppresses per-request flow noise; addon logs still appear via Python logging
CMD ["mitmdump", \
     "--mode", "reverse:https://api.anthropic.com", \
     "--listen-host", "0.0.0.0", \
     "--listen-port", "8000", \
     "-q", \
     "-s", "/app/addon.py"]

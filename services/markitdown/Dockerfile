ARG PYTHON_IMAGE=docker.m.daocloud.io/library/python:3.12.13-slim-bookworm

FROM ${PYTHON_IMAGE} AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

WORKDIR /build
COPY requirements.lock ./
RUN pip install --require-hashes --requirement requirements.lock

FROM ${PYTHON_IMAGE} AS runtime

ARG SERVICE_UID=10002
ARG SERVICE_GID=10002
ARG ENGINE_BUILD_ID=development
ARG RELEASE_MANIFEST_SHA256=development

ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONPATH=/app/src \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONHASHSEED=random \
    MARKITDOWN_ENABLE_PLUGINS=false \
    MARKITDOWN_IMAGE_BUILD_ID=${ENGINE_BUILD_ID} \
    MARKITDOWN_IMAGE_RELEASE_MANIFEST_SHA256=${RELEASE_MANIFEST_SHA256}

LABEL org.opencontainers.image.title="Obsidian MarkItDown Fallback Service" \
      org.opencontainers.image.version="1.4.0" \
      io.obsidian-markitdown.engine-build-id="${ENGINE_BUILD_ID}" \
      io.obsidian-markitdown.release-manifest-sha256="${RELEASE_MANIFEST_SHA256}"

RUN groupadd --gid "${SERVICE_GID}" markitdown \
    && useradd --uid "${SERVICE_UID}" --gid "${SERVICE_GID}" \
        --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin markitdown

COPY --from=builder /opt/venv /opt/venv
COPY --chown=${SERVICE_UID}:${SERVICE_GID} src /app/src

WORKDIR /app
USER markitdown:markitdown
EXPOSE 8080

ENTRYPOINT ["python", "-m", "markitdown_service"]
CMD ["api"]

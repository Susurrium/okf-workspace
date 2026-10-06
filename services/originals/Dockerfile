FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml ./
COPY requirements.lock ./
COPY src ./src
RUN pip install --no-cache-dir -r requirements.lock && pip install --no-cache-dir --no-deps . && useradd --uid 10001 --create-home files && mkdir /data && chown files /data
USER files
ENV OKF_FILES_ROOT=/data
EXPOSE 8080
CMD ["uvicorn", "okf_originals_service.app:app_from_env", "--factory", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]

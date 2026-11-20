# The prep pipeline (docs/llm/PREP_PIPELINE_PLAN.md). Build context is prep/ (for bucket.py, shared with the mock):
#   docker build -f prep/pipeline/Dockerfile -t hydroviewer-pipeline prep
# For Apptainer, see the README: the SIF is built from this image, and Apptainer differs from Docker in ways the
# lines below cover: it starts in the host's working directory (not WORKDIR), so paths are absolute; it mounts the
# host's home, so Python must not load packages from ~/.local; its image is read-only, so the mount points exist.
FROM python:3.13.18-slim

WORKDIR /prep
COPY pipeline/requirements.txt pipeline/
RUN pip install --no-cache-dir -r pipeline/requirements.txt && mkdir /work /data
COPY bucket.py ./
COPY pipeline/ pipeline/
# Dask workers are fresh processes: they find the task modules through the path, not the script's directory.
ENV PYTHONPATH=/prep:/prep/pipeline PYTHONUNBUFFERED=1 PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1

ENTRYPOINT ["python", "/prep/pipeline/run.py"]

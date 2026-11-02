FROM python:3.13-slim

WORKDIR /prep
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY *.py ./

ENTRYPOINT ["python", "prep_cmip6.py"]

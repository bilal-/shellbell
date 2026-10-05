ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tmux libstdc++6 libatomic1 systemd dbus-user-session && rm -rf /var/lib/apt/lists/*
COPY archive.tar.gz /opt/archive.tar.gz
COPY install.sh /opt/install.sh
COPY test /opt/test
# The harness uses the archive's own Node, never an external Node/npm install.
# It is deliberately not on PATH, and the bootstrap installs from the archive.
RUN mkdir /opt/payload && tar -xzf /opt/archive.tar.gz -C /opt/payload --strip-components=1 && (getent passwd 1001 || useradd --uid 1001 --create-home fixture-b)
RUN cp /opt/payload/install.mjs /opt/install.mjs && cp /opt/payload/runtime-manifest.json /opt/runtime-manifest.json && cp -R /opt/payload/scripts /opt/scripts
ENV PATH=/usr/bin:/bin
ENV HOME="/work/home with spaces"
ENV TMPDIR=/work
USER 1000
CMD ["/bin/sh", "/opt/test/run.sh"]

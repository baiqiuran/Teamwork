# Isolated systemd/Nginx acceptance host; never a production packaging format.
FROM node:24.15.0-bookworm
ENV container=docker
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv nginx openssh-server sudo ca-certificates git curl libatomic1 && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]

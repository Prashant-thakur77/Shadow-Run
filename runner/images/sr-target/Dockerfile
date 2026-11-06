# Rehearsal image for Postgres targets: Postgres 16 + the Shadow Run guest driver.
# The cluster is initialised at build time so a clone starts in well under a second.
# Nothing in here is a secret: the sandbox gets a snapshot file and a plan, never a credential.
FROM postgres:16-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-psycopg procps iproute2 curl \
 && rm -rf /var/lib/apt/lists/*

ENV PGDATA=/opt/sr/pgdata
RUN mkdir -p /opt/sr/guest /opt/sr/pgdata /snap \
 && chown -R postgres:postgres /opt/sr/pgdata \
 && chmod 700 /opt/sr/pgdata \
 && su postgres -c "/usr/lib/postgresql/16/bin/initdb -D /opt/sr/pgdata --auth-local=peer --auth-host=reject --encoding=UTF8 --locale=C.UTF-8" \
 && cat >> /opt/sr/pgdata/postgresql.conf <<'CONF'
# unix socket only: the guest must not listen on any network interface
listen_addresses = ''
ssl = off
unix_socket_directories = '/var/run/postgresql'
# a clone is disposable, so durability is off for speed
fsync = off
synchronous_commit = off
full_page_writes = off
max_connections = 30
shared_buffers = 128MB
statement_timeout = 60000
track_counts = on
log_min_messages = warning
CONF

# Local connections only, by OS identity. The driver runs as root and may act as either role;
# the agent OS user can only ever be the unprivileged agent role.
RUN printf 'local all all peer map=sr\n' > /opt/sr/pgdata/pg_hba.conf \
 && printf 'sr root postgres\nsr root agent\nsr postgres postgres\nsr postgres agent\nsr agent agent\n' > /opt/sr/pgdata/pg_ident.conf \
 && chown postgres:postgres /opt/sr/pgdata/pg_hba.conf /opt/sr/pgdata/pg_ident.conf

COPY capture.sql txrun.py driver.py /opt/sr/guest/
RUN chmod 755 /opt/sr/guest && chmod 644 /opt/sr/guest/*

# The base image ships a self-signed key. It is unused here (no TCP) and would trip the secret scan.
RUN rm -f /etc/ssl/private/ssl-cert-snakeoil.key && rm -rf /etc/ssl/certs/* /usr/share/ca-certificates /usr/lib/ssl/cert.pem /usr/share/gnupg/sks-keyservers.netCA.pem

# OS user for plan shell steps; maps to the unprivileged Postgres role of the same name.
RUN useradd --create-home --shell /bin/bash agent

ENTRYPOINT []
CMD ["sleep", "infinity"]

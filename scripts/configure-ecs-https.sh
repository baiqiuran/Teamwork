#!/usr/bin/env bash
# Run on the ECS host: sudo bash configure-ecs-https.sh
set -Eeuo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
[[ $EUID == 0 ]]
CONF=/etc/nginx/conf.d/new-chat.conf
DRAFT=/etc/nginx/new-chat-https.conf.pending
ENV_FILE=/etc/new-chat/new-chat.env
[[ -f $CONF && -f $DRAFT && -f $ENV_FILE ]]
systemctl is-active --quiet new-chat.service

# Certbot verifies the actual DNS and HTTP challenge before issuing a certificate.
certbot certonly --non-interactive --webroot \
  --webroot-path /var/www/new-chat-acme \
  --cert-name new-chat --domain daily.hbads.cn --keep-until-expiring \
  --deploy-hook '/usr/sbin/nginx -t && /usr/bin/systemctl reload nginx'

BACKUP=$(mktemp -d /etc/new-chat/https-before.XXXXXXXX)
cp -a "$CONF" "$BACKUP/nginx.conf"
cp -a "$ENV_FILE" "$BACKUP/application.env"
restore_config() {
  result=$?
  trap - ERR
  cp -a "$BACKUP/nginx.conf" "$CONF"
  cp -a "$BACKUP/application.env" "$ENV_FILE"
  if nginx -t; then systemctl reload nginx; fi
  systemctl restart new-chat.service || true
  echo "HTTPS configuration failed. Previous configuration restored from $BACKUP." >&2
  exit "$result"
}
trap restore_config ERR
install -m 644 "$DRAFT" "$CONF"
nginx -t
sed '/^[[:space:]]*DAILY_PUBLIC_URL[[:space:]]*=/d' "$ENV_FILE" >"$BACKUP/application.next.env"
printf '\nDAILY_PUBLIC_URL=https://daily.hbads.cn\n' >>"$BACKUP/application.next.env"
install -m 600 "$BACKUP/application.next.env" "$ENV_FILE"
systemctl restart new-chat.service
READY=0
for attempt in {1..30}; do
  if curl -fsS --max-time 2 http://127.0.0.1:4312/health/ready >/dev/null; then READY=1; break; fi
  sleep 1
done
[[ $READY == 1 ]]
systemctl reload nginx
sleep 1
curl -fsS --max-time 10 --resolve daily.hbads.cn:443:127.0.0.1 https://daily.hbads.cn/login >/dev/null
[[ $(curl -s --max-time 10 -o /dev/null -w '%{http_code}' --resolve daily.hbads.cn:443:127.0.0.1 https://daily.hbads.cn/internal/health) == 404 ]]
trap - ERR
printf 'HTTPS enabled: https://daily.hbads.cn\nPrevious configuration: %s\n' "$BACKUP"
systemctl is-active new-chat.service Rid-Rs.service nginx.service

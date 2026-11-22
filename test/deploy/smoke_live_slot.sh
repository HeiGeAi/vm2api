#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
image=node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
scratch=$(mktemp -d /root/vm2api-live.XXXXXX)
observer_net="vm2api-live-observer-$$"
ssh_peer="vm2api-live-peer-$$"
observer_pid=
forwarder_pid=
sshd_pid=
egress_started=false

egress() {
  node --input-type=module - "$1" "$scratch" <<'JS'
import assert from 'node:assert/strict'
import { ensureProxyEgress, stopProxyEgress } from './src/lib/vm/egress.mjs'

const [action, root] = process.argv.slice(2)
const id = 'px-ci-live'
if (action === 'start') {
  const proxy = { id, url: 'socks5h://127.0.0.1:18080' }
  const result = await ensureProxyEgress(root, proxy, { bin: `${process.cwd()}/bin/kin-egress` })
  assert.equal(result.ok, true, result.error)
  console.log(result.network)
} else {
  stopProxyEgress(root, id)
}
JS
}

cleanup() {
  local result=$?
  set +e
  if (( result != 0 )); then
    for log in sshd observer; do
      if [[ -f "$scratch/$log.log" ]]; then tail -15 "$scratch/$log.log"; fi
    done
  fi
  if $egress_started; then egress stop; fi
  for pid in "$observer_pid" "$forwarder_pid" "$sshd_pid"; do
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null; fi
  done
  docker rm -f "$ssh_peer" >/dev/null 2>&1
  docker network rm "$observer_net" >/dev/null 2>&1
  rm -rf -- "$scratch"
  return "$result"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir -p -m 0700 /run/sshd
docker network create "$observer_net" >/dev/null
docker run -d --name "$ssh_peer" --network "$observer_net" "$image" sleep infinity >/dev/null
observer_ip=$(docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' "$observer_net")
peer_ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$ssh_peer")
peer_pid=$(docker inspect -f '{{.State.Pid}}' "$ssh_peer")

# A disposable OpenSSH server on the private Docker bridge uses the runner's test files.
ssh-keygen -q -t ed25519 -N '' -f "$scratch/host"
ssh-keygen -q -t ed25519 -N '' -f "$scratch/client"
install -m 0600 "$scratch/client.pub" "$scratch/authorized_keys"
printf '[%s]:18222 %s\n' "$peer_ip" "$(cut -d ' ' -f 1-2 "$scratch/host.pub")" > "$scratch/known_hosts"
cat > "$scratch/sshd.conf" <<EOF
ListenAddress $peer_ip
Port 18222
PidFile $scratch/sshd.pid
HostKey $scratch/host
AuthorizedKeysFile $scratch/authorized_keys
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowUsers root
UsePAM yes
AllowTcpForwarding local
Subsystem sftp internal-sftp
LogLevel DEBUG1
EOF
nsenter -t "$peer_pid" -n /usr/sbin/sshd -D -e -f "$scratch/sshd.conf" 2> "$scratch/sshd.log" &
sshd_pid=$!
for (( attempt=0; attempt<20; attempt++ )); do
  if nsenter -t "$peer_pid" -n ss -lnt | grep -q ':18222'; then break; fi
  kill -0 "$sshd_pid"
  sleep 0.5
done
LIVE_SLOT_SSH_DIR="$scratch" LIVE_SLOT_SSH_HOST="$peer_ip" node --test test/deploy/live_slot_ssh.mjs

ssh -F /dev/null -i "$scratch/client" -o UserKnownHostsFile="$scratch/known_hosts" \
  -o StrictHostKeyChecking=yes -o BatchMode=yes -o ExitOnForwardFailure=yes -o ConnectTimeout=10 \
  -N -D 127.0.0.1:18080 -p 18222 "root@$peer_ip" &
forwarder_pid=$!
for (( attempt=0; attempt<20; attempt++ )); do
  if ss -lnt | grep -q '127.0.0.1:18080'; then break; fi
  kill -0 "$forwarder_pid"
  sleep 0.5
done

credential_dir="$scratch/credentials"
mkdir -m 0700 "$credential_dir"
printf '{"fixture":true}\n' > "$credential_dir/credentials.json"
chmod 600 "$credential_dir/credentials.json"
ln -s credentials.json "$credential_dir/.credentials.json"
chown -R 10001:987 "$credential_dir"
credential_digest=$(sha256sum "$credential_dir/credentials.json")

cert="$scratch/probe.crt"
openssl req -x509 -nodes -days 1 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -subj '/CN=vm2api-ci-observer' -addext "subjectAltName=IP:$observer_ip" \
  -keyout "$scratch/probe.key" -out "$cert" >/dev/null 2>&1
python3 test/deploy/live_slot_observer.py "$observer_ip" 18443 "$cert" "$scratch/probe.key" \
  2> "$scratch/observer.log" &
observer_pid=$!
probe="https://$observer_ip:18443/"
direct_ip=$(curl --noproxy '*' -fsS --retry 5 --retry-connrefused --max-time 3 --cacert "$cert" "$probe")
proxied_ip=$(curl --noproxy '' -fsS --socks5-hostname 127.0.0.1:18080 --max-time 10 --cacert "$cert" "$probe")
[[ "$direct_ip" != "$proxied_ip" && "$proxied_ip" == "$peer_ip" ]]

egress_started=true
slot_net=$(egress start)
docker run --rm --network "$slot_net" \
  -v "$PWD/test/unit/crs-live-stability.test.mjs:/suite/live.test.mjs:ro" \
  -v "$cert:/fixture/probe.crt:ro" -v "$credential_dir:/fixture/creds" \
  -e KIN_LIVE_NET=1 -e KIN_LIVE_DIRECT_IP="$direct_ip" -e KIN_LIVE_IP_URL="$probe" \
  -e KIN_LIVE_CREDENTIAL_DIR=/fixture/creds -e NODE_EXTRA_CA_CERTS=/fixture/probe.crt \
  "$image" node --test /suite/live.test.mjs

# Observe the baseline SOCKS request and all five slot requests from the actual SSH peer.
[[ $(awk -v peer="$peer_ip" '$1 == peer && /GET \/ HTTP/ { count++ } END { print count+0 }' "$scratch/observer.log") -eq 6 ]]
[[ $(grep -c 'server_request_direct_tcpip' "$scratch/sshd.log") -ge 11 ]]
[[ $(sha256sum "$credential_dir/credentials.json") == "$credential_digest" ]]
echo 'SOCKS peer and writable credential checks passed'

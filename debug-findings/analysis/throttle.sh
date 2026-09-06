#!/bin/bash
# Prints the dummynet lines for one impairment profile on the local relay port (4443, UDP+TCP,
# both directions). The user runs them with the `!` prefix (sudo). Usage: throttle.sh <profile|off>
# Profiles: p20 (20 ms RTT, 0.1 % loss), p80 (80 ms, 0.5 %), p200 (200 ms, 1 %), p80cap (80 ms, 2 Mbit)
case "${1:-}" in
  p20)    D=10ms;  L=0.001; BW="";;
  p80)    D=40ms;  L=0.005; BW="";;
  p200)   D=100ms; L=0.01;  BW="";;
  p80cap) D=40ms;  L=0.005; BW="bw 2Mbit/s";;
  off) cat <<'OFF'
sudo pfctl -a moq-rt -F all; sudo dnctl -q flush; sudo pfctl -d
OFF
  exit 0;;
  *) echo "usage: throttle.sh p20|p80|p200|p80cap|off"; exit 1;;
esac
cat <<ON
sudo dnctl pipe 1 config delay $D plr $L $BW
printf 'dummynet in quick proto {tcp,udp} from any to any port 4443 pipe 1\ndummynet out quick proto {tcp,udp} from any to any port 4443 pipe 1\n' | sudo pfctl -a moq-rt -f -
sudo pfctl -e
ON

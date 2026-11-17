#!/bin/sh
set -e
mkdir -p /shared /recordings
chmod 777 /shared
# guacd runs as uid 1000 and writes session recordings here.
chown 1000:1000 /recordings

echo 'e2e-pass' | vncpasswd -f > /tmp/vncpasswd
chmod 600 /tmp/vncpasswd

# -AcceptSetDesktopSize=0: Xvnc would otherwise resize its screen to the
# browser window. TightVNC on Windows cannot, and fit-to-window scaling of a
# fixed-size desktop is the path that needs proving.
# -noreset: an X server otherwise resets (wiping the root colour) whenever its
# last client disconnects, which xsetroot is at the moment it exits.
Xvnc :0 -geometry 1024x768 -depth 24 -rfbport 5900 \
     -SecurityTypes VncAuth -rfbauth /tmp/vncpasswd -AlwaysShared \
     -AcceptSetDesktopSize=0 -nolisten tcp -noreset &
export DISPLAY=:0
i=0
until xdpyinfo >/dev/null 2>&1; do i=$((i+1)); [ "$i" -gt 100 ] && exit 1; sleep 0.1; done

# Root window colour the test samples from the browser canvas: rgb(48,96,192).
xsetroot -solid '#3060c0'

# A terminal in the BOTTOM-RIGHT quadrant. With no window manager, keyboard
# focus follows the pointer, so typed text only lands in /shared/typed if the
# browser maps mouse coordinates through the display scale correctly. A click
# at unscaled coordinates would hit the bare root window instead.
xterm -geometry 60x20+520+420 -fa 'DejaVu Sans Mono' -fs 9 \
      -e sh -c 'stty -echo; exec cat > /shared/typed' &

# Clipboard bridge for the test: /shared/clip-set -> X selections, and both
# selections -> /shared/clip-out-*.
while :; do
  if [ -f /shared/clip-set ]; then
    xclip -selection clipboard -i < /shared/clip-set
    xclip -selection primary -i < /shared/clip-set
    rm -f /shared/clip-set
  fi
  xclip -o -selection clipboard > /shared/.c 2>/dev/null && mv /shared/.c /shared/clip-out-clipboard
  xclip -o -selection primary   > /shared/.p 2>/dev/null && mv /shared/.p /shared/clip-out-primary
  sleep 0.3
done

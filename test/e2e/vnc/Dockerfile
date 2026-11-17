# A disposable VNC server for the end-to-end test: an X display with a known
# background colour and a terminal whose input lands in a file the test reads.
#
# TigerVNC's Xvnc rather than Xvfb + x11vnc: Xvnc syncs the clipboard natively
# in both directions, while x11vnc 0.9.16 accepted cut text from the client but
# never applied it or sent selection changes back.
FROM debian:12-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tigervnc-standalone-server tigervnc-tools xterm x11-utils x11-xserver-utils xclip fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
COPY start.sh /start.sh
RUN chmod +x /start.sh
CMD ["/start.sh"]

// Shared by the main UI and the hub's terminal.
/**
 * Swipe to scroll on phones and tablets: xterm.js doesn't scroll on touch. In the normal
 * buffer this moves through the scrollback; in the alternate screen (full-screen apps) it
 * sends wheel events so the app scrolls itself. A flick keeps scrolling and slows down.
 */
export function touchScroll(el, xterm) {
  let lastY = null;
  let lastT = 0;
  let carry = 0; // fraction of a line not scrolled yet
  let velocity = 0; // px per ms
  let glide = 0;
  const lineHeight = () => el.querySelector('.xterm-screen')?.clientHeight / xterm.rows || 17;
  const scrollPx = (dy) => {
    carry += dy / lineHeight();
    const lines = Math.trunc(carry);
    if (!lines) return;
    carry -= lines;
    if (xterm.buffer.active.type === 'normal') {
      xterm.scrollLines(lines);
    } else {
      const target = el.querySelector('.xterm-screen');
      const r = target.getBoundingClientRect();
      for (let i = 0; i < Math.abs(lines); i++) {
        target.dispatchEvent(
          new WheelEvent('wheel', { deltaY: Math.sign(lines) * lineHeight(), deltaMode: 0, clientX: r.left + 10, clientY: r.top + 10, bubbles: true, cancelable: true }),
        );
      }
    }
  };
  el.addEventListener(
    'touchstart',
    (e) => {
      cancelAnimationFrame(glide);
      if (e.touches.length !== 1) return (lastY = null);
      lastY = e.touches[0].clientY;
      lastT = e.timeStamp;
      velocity = 0;
      carry = 0;
    },
    { passive: true },
  );
  el.addEventListener(
    'touchmove',
    (e) => {
      if (lastY === null || e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      const dy = lastY - y; // finger up = later content
      const dt = Math.max(1, e.timeStamp - lastT);
      velocity = 0.8 * (dy / dt) + 0.2 * velocity;
      lastY = y;
      lastT = e.timeStamp;
      e.preventDefault();
      scrollPx(dy);
    },
    { passive: false },
  );
  el.addEventListener('touchend', (e) => {
    if (lastY === null) return;
    lastY = null;
    if (e.timeStamp - lastT > 80 || Math.abs(velocity) < 0.2) return; // finger paused: no flick
    let prev = performance.now();
    const step = (now) => {
      const dt = now - prev;
      prev = now;
      velocity *= Math.pow(0.995, dt);
      if (Math.abs(velocity) < 0.03) return;
      scrollPx(velocity * dt);
      glide = requestAnimationFrame(step);
    };
    glide = requestAnimationFrame(step);
  });
}

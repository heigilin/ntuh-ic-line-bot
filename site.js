const nav = document.querySelector('.nav');
const video = document.querySelector('.hero-video');
const soundButton = document.querySelector('#sound-toggle');
const autoScrollStart = document.querySelector('#auto-scroll-start');
const readingControl = document.querySelector('#reading-control');
const readingIcon = readingControl?.querySelector('.reading-icon');
const readingLabel = readingControl?.querySelector('.reading-label');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const petalField = document.querySelector('#petal-field');
const pageTurn = document.querySelector('#page-turn');
const hero = document.querySelector('.hero');
const videoIntro = document.querySelector('#video-intro');
const introVideo = document.querySelector('#intro-video');
const introSound = document.querySelector('#intro-sound');
const introSkip = document.querySelector('#intro-skip');
const introProgressBar = document.querySelector('#intro-progress-bar');
let autoReading = false;
let readingFrame = 0;
let previousTime = 0;
let readingPosition = 0;
const readingSpeed = 26;
let readingPageIndex = 0;
const readingPages = [...document.querySelectorAll('main > section')];

if (video) video.muted = true;
if (introVideo) introVideo.muted = false;

if (!document.body.classList.contains('intro-playing')) {
  hero?.classList.add('hero-ready', 'intro-done');
  video?.play().catch(() => {});
}

function enterWebsite() {
  if (!document.body.classList.contains('intro-playing')) return;
  document.body.classList.remove('intro-playing');
  videoIntro?.classList.add('finished');
  introVideo?.pause();
  video?.play().catch(() => {});

  if (reduceMotion.matches) {
    hero?.classList.add('hero-ready', 'intro-done');
  } else {
    setTimeout(() => hero?.classList.add('hero-ready'), 900);
    setTimeout(() => hero?.classList.add('intro-done'), 1900);
  }
}

if (document.body.classList.contains('intro-playing')) video?.pause();
introVideo?.addEventListener('ended', enterWebsite);
introVideo?.addEventListener('error', enterWebsite);
introSkip?.addEventListener('click', enterWebsite);
introSound?.addEventListener('click', () => {
  introVideo.muted = !introVideo.muted;
  introSound.setAttribute('aria-pressed', String(!introVideo.muted));
  introSound.textContent = introVideo.muted ? '開啟聲音' : '關閉聲音';
  introVideo.play().catch(() => {});
});
introVideo?.addEventListener('timeupdate', () => {
  const progress = introVideo.duration ? introVideo.currentTime / introVideo.duration * 100 : 0;
  introProgressBar.style.width = `${Math.min(progress, 100)}%`;
});

if (petalField && !reduceMotion.matches) {
  const colors = ['petal-rose', 'petal-cream', 'leaf-sage'];
  for (let index = 0; index < 18; index += 1) {
    const petal = document.createElement('i');
    petal.className = `wind-petal ${colors[index % colors.length]}`;
    petal.style.setProperty('--x', `${(index * 37) % 101}vw`);
    petal.style.setProperty('--drift', `${70 + (index % 5) * 24}px`);
    petal.style.setProperty('--duration', `${11 + (index % 7) * 1.4}s`);
    petal.style.setProperty('--delay', `${-index * 1.7}s`);
    petal.style.setProperty('--size', `${8 + (index % 4) * 3}px`);
    petalField.appendChild(petal);
  }
}

addEventListener('scroll', () => nav.classList.toggle('scrolled', scrollY > 40), { passive: true });

soundButton?.addEventListener('click', () => {
  video.muted = !video.muted;
  soundButton.setAttribute('aria-pressed', String(!video.muted));
  soundButton.textContent = video.muted ? '開啟影片聲音' : '關閉影片聲音';
  if (video.paused) video.play();
});

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.14 });
document.querySelectorAll('.reveal').forEach((element) => observer.observe(element));

function updateReadingControl() {
  readingControl.hidden = false;
  readingControl.classList.toggle('paused', !autoReading);
  readingControl.setAttribute('aria-pressed', String(autoReading));
  readingIcon.textContent = autoReading ? 'Ⅱ' : '▶';
  readingLabel.textContent = autoReading ? '暫停閱讀' : '繼續閱讀';
}

function readingStep(time) {
  if (!autoReading) return;
  if (!previousTime) previousTime = time;
  const elapsed = Math.min(time - previousTime, 50);
  previousTime = time;
  readingPosition += readingSpeed * elapsed / 1000;
  scrollTo(0, readingPosition);
  if (innerHeight + scrollY >= document.documentElement.scrollHeight - 2) {
    stopAutoReading(false);
    readingControl.hidden = true;
    return;
  }
  readingFrame = requestAnimationFrame(readingStep);
}

function startAutoReading() {
  if (reduceMotion.matches) return;
  autoReading = true;
  document.documentElement.classList.add('auto-reading');
  previousTime = 0;
  readingPosition = scrollY;
  updateReadingControl();
  clearInterval(readingFrame);
  clearInterval(readingFrame);
  readingFrame = setInterval(() => {
    scrollBy(0, 1);
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 2) {
      stopAutoReading(false);
      readingControl.hidden = true;
    }
  }, 40);
}

function stopAutoReading(showControl = true) {
  autoReading = false;
  document.documentElement.classList.remove('auto-reading');
  clearInterval(readingFrame);
  if (showControl) updateReadingControl();
}

function scheduleNextPage(delay) {
  clearTimeout(readingFrame);
  readingFrame = setTimeout(() => {
    if (!autoReading) return;
    if (readingPageIndex >= readingPages.length) {
      stopAutoReading(false);
      readingControl.hidden = true;
      return;
    }
    const nextPage = readingPages[readingPageIndex];
    pageTurn.classList.remove('active');
    void pageTurn.offsetWidth;
    pageTurn.classList.add('active');
    nextPage.scrollIntoView({ behavior: 'smooth', block: 'start' });
    readingPageIndex += 1;
    const textLength = nextPage.innerText.replace(/\s/g, '').length;
    const readingDelay = Math.min(9000, Math.max(6000, textLength * 28));
    scheduleNextPage(readingDelay);
  }, delay);
}

autoScrollStart?.addEventListener('click', startAutoReading);
readingControl?.addEventListener('click', () => autoReading ? stopAutoReading() : startAutoReading());
['wheel', 'touchstart', 'pointerdown'].forEach((eventName) => {
  addEventListener(eventName, (event) => {
    if (autoReading && !event.target.closest?.('#reading-control, #auto-scroll-start')) stopAutoReading();
  }, { passive: true });
});
addEventListener('keydown', () => { if (autoReading) stopAutoReading(); });
reduceMotion.addEventListener('change', () => { if (reduceMotion.matches) stopAutoReading(false); });

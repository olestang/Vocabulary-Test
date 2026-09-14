import { APP_CONFIG } from './config.js';
import { storage } from './storage.js';
import { verifySignedToken } from './cryptography.js';

function relativeRoot() {
  const path = location.pathname;
  return /\/(teacher|submit|results|history|diagnostics|become-teacher)\/?$/.test(path) ? '../' : './';
}

function addLink(container, href, text, marker) {
  if (container.querySelector(`[data-auto-nav="${marker}"]`)) return;
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  a.dataset.autoNav = marker;
  container.appendChild(a);
}

async function initTeacherNavigation() {
  const token = storage.getTeacherAccessToken();
  let isTeacher = false;
  if (token) {
    const result = await verifySignedToken(token, APP_CONFIG.teacherTokenKinds.access);
    isTeacher = result.ok;
    if (!isTeacher) storage.clearTeacherAccessToken();
  }
  document.documentElement.classList.toggle('teacher-enabled', isTeacher);
  document.querySelectorAll('[data-teacher-nav]').forEach(el => { el.hidden = !isTeacher; });
  document.querySelectorAll('[data-not-teacher-nav]').forEach(el => { el.hidden = isTeacher; });

  const header = document.querySelector('.header-meta');
  if (!header) return;
  const root = relativeRoot();
  if (isTeacher) {
    addLink(header, `${root}teacher/`, 'Teacher dashboard', 'teacher-dashboard');
    addLink(header, `${root}diagnostics/`, 'Diagnostics', 'diagnostics');
  } else if (!location.pathname.includes('/become-teacher/')) {
    addLink(header, `${root}become-teacher/`, 'Teacher access', 'become-teacher');
  }
}

initTeacherNavigation();

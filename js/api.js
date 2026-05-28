/* ============================================================
   API 通信模块 — 封装所有与后端的 HTTP 请求
   ============================================================ */
const API = {
  base: '', // 同源请求

  async request(method, url, data) {
    const opts = { method, headers: {} };
    if (data instanceof FormData) {
      opts.body = data; // 上传文件时不设 Content-Type，让浏览器自动设置
    } else if (data) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(data);
    }
    const res = await fetch(this.base + url, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: '请求失败' }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  // ── Settings ──
  getSettings:   ()          => API.request('GET',  '/api/settings'),
  saveSetting:   (key, value) => API.request('PUT',  '/api/settings', { key, value }),

  // ── Notes ──
  getNotes:      ()          => API.request('GET',  '/api/notes'),
  addNote:       (content)   => API.request('POST', '/api/notes', { content }),
  deleteNote:    (id)        => API.request('DELETE', `/api/notes/${id}`),

  // ── Diary ──
  getDiary:      ()          => API.request('GET',  '/api/diary'),
  addDiaryEntry: (data)      => API.request('POST', '/api/diary', data),
  deleteDiary:   (id)        => API.request('DELETE', `/api/diary/${id}`),

  // ── Timeline ──
  getTimeline:      ()       => API.request('GET',  '/api/timeline'),
  addTimelineEvent: (data)   => API.request('POST', '/api/timeline', data),
  deleteTimeline:   (id)     => API.request('DELETE', `/api/timeline/${id}`),

  // ── Photos ──
  getPhotos:    ()           => API.request('GET',  '/api/photos'),
  uploadPhoto:  (formData)   => API.request('POST', '/api/photos/upload', formData),
  deletePhoto:  (id)         => API.request('DELETE', `/api/photos/${id}`),
};

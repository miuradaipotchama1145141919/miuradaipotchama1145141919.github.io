const TopBar = (function () {
    function toElement(html) {
        const template = document.createElement('template');
        template.innerHTML = html.trim();

        return template.content.firstElementChild;
    }

    function langButton(code) {
        return `<button type="button" class="btn btn-outline-primary" data-lang="${code}">${code.toUpperCase()}</button>`;
    }

    function barHtml(languages) {
        return `
    <div class="top-bar">
      <div class="btn-group lang-group" role="group" aria-label="Language">${languages.map(langButton).join('')}</div>
      <button type="button" class="btn btn-outline-primary help-btn" data-bs-toggle="modal"
        data-bs-target="#aboutModal" aria-label="Help">?</button>
    </div>`;
    }

    const modalHtml = `
    <div class="modal fade" id="aboutModal" tabindex="-1" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h2 class="modal-title fs-5" data-i18n="aboutTitle"></h2>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body" data-i18n-html="aboutBody"></div>
          <div class="modal-footer">
            <button type="button" class="btn btn-primary rounded-pill" data-bs-dismiss="modal" data-i18n="close"></button>
          </div>
        </div>
      </div>
    </div>`;

    function setActiveLanguage(root, code) {
        root.querySelectorAll('[data-lang]').forEach(function (button) {
            const active = button.dataset.lang === code;

            button.classList.toggle('btn-primary', active);
            button.classList.toggle('btn-outline-primary', !active);
            button.setAttribute('aria-pressed', String(active));
        });
    }

    function mount(root, { languages, active, onLanguage }) {
        root.replaceChildren(toElement(barHtml(languages)));

        if (!document.getElementById('aboutModal')) document.body.appendChild(toElement(modalHtml));

        setActiveLanguage(root, active);

        root.addEventListener('click', function (event) {
            const button = event.target.closest('[data-lang]');

            if (!button) return;

            setActiveLanguage(root, button.dataset.lang);
            onLanguage(button.dataset.lang);
        });
    }

    return { mount, setActiveLanguage };
}());

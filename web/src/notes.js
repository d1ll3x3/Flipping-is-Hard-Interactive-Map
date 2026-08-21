import { loadNotes, saveNotes, savingConfigured } from './save.js';

/**
 * The editors' shared note: a floating window with whatever they need to tell each other -
 * how to record a clip, what to call things, what is still missing.
 *
 * It only exists for someone who opened the map with ?edit=1 and got the passphrase right,
 * and the text itself is not in the site either - it is fetched from the Worker, which asks
 * for the passphrase before answering. So a visitor cannot read it by looking at the bundle.
 *
 * Floating rather than another box in the side panel because it is meant to be read while
 * working: it sits over the map, is dragged out of the way by its title bar, rolls up to
 * that bar, and closes altogether. Closed, it is reopened from the editor's own panel -
 * there is no way to lose it.
 */
export class Notes {
  /** `panel` is the editor's, where the button that brings the window back lives. */
  constructor(panel) {
    this.dirty = false;
    this.updatedAt = null;

    this.element = document.createElement('section');
    this.element.id = 'notes';
    this.element.innerHTML = `
      <header>
        <h2>Editor notes</h2>
        <span class="window-buttons">
          <button type="button" class="roll" title="Roll up">–</button>
          <button type="button" class="shut" title="Close" aria-label="Close">×</button>
        </span>
      </header>
      <div class="body">
        <textarea rows="10" placeholder="Anything the other editors should know…"></textarea>
        <div class="row-buttons">
          <button type="button" class="save primary">Save note</button>
          <button type="button" class="reload">Reload</button>
        </div>
        <p class="hint"></p>
      </div>
    `;
    document.body.append(this.element);

    this.textarea = this.element.querySelector('textarea');
    this.hint = this.element.querySelector('.hint');
    this.saveButton = this.element.querySelector('.save');
    this.header = this.element.querySelector('header');

    this.textarea.addEventListener('input', () => {
      this.dirty = true;
    });
    this.saveButton.addEventListener('click', () => this.save());
    this.element.querySelector('.reload').addEventListener('click', () => this.reload());
    this.element.querySelector('.roll').addEventListener('click', () => {
      this.element.classList.toggle('rolled');
    });
    this.element.querySelector('.shut').addEventListener('click', () => this.show(false));

    this.addButton(panel);
    this.drag();
    this.load();
  }

  /**
   * The way back in. It is in the editor's panel rather than on the map because that panel
   * is already the editor's set of controls, and a floating button to reopen a floating
   * window would be one more thing over the level.
   */
  addButton(panel) {
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.addEventListener('click', () => this.show(this.element.hidden));
    panel.append(this.button);
    // Through show(), so the label says what the button will do rather than having to be
    // kept in step with it in two places.
    this.show(true);
  }

  /**
   * Closing only hides the window: what was typed and not saved is still in the textarea
   * when it comes back, which is what someone who closed it to look at the map underneath
   * expects.
   */
  show(visible) {
    this.element.hidden = !visible;
    this.button.textContent = visible ? 'Hide notes' : 'Editor notes';
  }

  async load() {
    if (!savingConfigured()) {
      this.textarea.disabled = true;
      this.saveButton.disabled = true;
      this.hint.textContent = 'The note lives on the save service, which is not set up on this deployment.';
      return;
    }

    this.hint.textContent = 'Loading…';

    try {
      const { text, updatedAt } = await loadNotes();
      this.textarea.value = text;
      this.updatedAt = updatedAt;
      this.dirty = false;
      this.hint.textContent = updatedAt ? `Last changed ${when(updatedAt)}.` : 'Nothing written yet.';
    } catch (error) {
      this.hint.textContent = `Could not load the note: ${error.message}`;
    }
  }

  /** Re-reads what is stored, which throws away anything typed since - so it asks first. */
  async reload() {
    if (this.dirty && !confirm('Reload the note and lose what you have typed?')) return;
    await this.load();
  }

  async save() {
    this.saveButton.disabled = true;
    this.hint.textContent = 'Saving…';

    try {
      const { updatedAt } = await saveNotes(this.textarea.value, this.updatedAt);
      this.updatedAt = updatedAt;
      this.dirty = false;
      this.hint.textContent = `Saved ${when(updatedAt)}.`;
    } catch (error) {
      this.hint.textContent = `Not saved: ${error.message}`;
    } finally {
      this.saveButton.disabled = false;
    }
  }

  /**
   * Moves the window by its title bar.
   *
   * The pointer is captured on the header, so the drag survives the cursor running ahead of
   * the window or off over the canvas - without that, moving fast drops the window where the
   * pointer left it.
   */
  drag() {
    let from = null;

    this.header.addEventListener('pointerdown', (event) => {
      // The two window buttons are in the title bar, and a drag must not start on them.
      // Not for tidiness: capturing the pointer below hands the click that follows to the
      // header rather than to the button under the finger, so rolling up and closing both
      // stopped happening at all.
      if (event.target.closest('button')) return;

      const box = this.element.getBoundingClientRect();
      from = { x: event.clientX - box.left, y: event.clientY - box.top };
      // Placed by left/top from here on, so the right/bottom it starts with has to go or the
      // window would be stretched between the two.
      this.element.style.right = 'auto';
      this.element.style.bottom = 'auto';
      this.header.setPointerCapture(event.pointerId);
    });

    this.header.addEventListener('pointermove', (event) => {
      if (!from) return;
      // Kept on screen: dragged past an edge, the title bar is the one part that must stay
      // reachable, or there is no way to drag it back.
      const box = this.element.getBoundingClientRect();
      const x = clamp(event.clientX - from.x, 0, innerWidth - box.width);
      const y = clamp(event.clientY - from.y, 0, innerHeight - this.header.offsetHeight);

      this.element.style.left = `${x}px`;
      this.element.style.top = `${y}px`;
    });

    this.header.addEventListener('pointerup', () => {
      from = null;
    });
  }
}

const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));

/** The stored timestamp in the reader's own time, since they are the one deciding whether
 * it is recent. */
const when = (iso) => new Date(iso).toLocaleString();

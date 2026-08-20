/**
 * The curated subset of Lucide that ships in @artboard/icons.
 *
 * Lucide has ~2000 icons. Shipping all of them would put ~700 KB of path data
 * in every bundle for a drawer nobody scrolls to the bottom of, so this file is
 * the editorial decision: roughly 300 icons a poster/deck/social-post designer
 * actually reaches for, grouped the way they'd look for them.
 *
 * Order inside a category is the order they appear in the drawer.
 */
export const CATEGORIES = [
  { id: 'arrows', label: 'Arrows' },
  { id: 'ui', label: 'Interface' },
  { id: 'media', label: 'Media' },
  { id: 'communication', label: 'Comms' },
  { id: 'files', label: 'Files' },
  { id: 'commerce', label: 'Commerce' },
  { id: 'social', label: 'Social' },
  { id: 'weather', label: 'Weather' },
  { id: 'nature', label: 'Nature' },
  { id: 'symbols', label: 'Symbols' },
];

/** category id -> lucide icon file names (without `.svg`). */
export const PICKS = {
  arrows: [
    'arrow-up', 'arrow-down', 'arrow-left', 'arrow-right',
    'arrow-up-right', 'arrow-up-left', 'arrow-down-right', 'arrow-down-left',
    'arrow-left-right', 'arrow-up-down',
    'arrow-big-up', 'arrow-big-down', 'arrow-big-left', 'arrow-big-right',
    'chevron-up', 'chevron-down', 'chevron-left', 'chevron-right',
    'chevrons-up', 'chevrons-down', 'chevrons-left', 'chevrons-right',
    'circle-arrow-up', 'circle-arrow-down', 'circle-arrow-left', 'circle-arrow-right',
    'corner-up-left', 'corner-up-right', 'corner-down-left', 'corner-down-right',
    'move', 'move-horizontal', 'move-vertical',
    'undo-2', 'redo-2', 'refresh-cw', 'refresh-ccw', 'repeat', 'shuffle',
    'trending-up', 'trending-down', 'external-link',
    'expand', 'shrink', 'maximize', 'minimize',
    'log-in', 'log-out', 'milestone', 'split', 'merge',
  ],
  ui: [
    'search', 'settings', 'sliders-horizontal', 'filter', 'menu',
    'ellipsis', 'ellipsis-vertical', 'layout-grid', 'layout-list', 'list', 'list-checks',
    'check', 'x', 'plus', 'minus',
    'circle-check', 'circle-x', 'circle-alert', 'triangle-alert', 'info', 'circle-help',
    'lock', 'lock-open', 'key', 'shield', 'shield-check', 'power',
    'house', 'calendar', 'clock', 'timer', 'hourglass',
    'pencil', 'pen-tool', 'eraser', 'palette', 'paintbrush', 'pipette',
    'ruler', 'crop', 'wand-sparkles', 'layers', 'zoom-in', 'zoom-out',
    'toggle-left', 'toggle-right', 'loader', 'link', 'unlink',
    'terminal', 'code', 'bug', 'command', 'trash-2', 'eye', 'eye-off',
    'align-left', 'align-center', 'align-right', 'bold', 'italic', 'underline',
  ],
  media: [
    'play', 'pause', 'circle-play', 'circle-pause', 'circle-stop',
    'skip-forward', 'skip-back', 'fast-forward', 'rewind',
    'volume-2', 'volume-1', 'volume-x',
    'music', 'music-2', 'music-4', 'headphones', 'audio-lines', 'audio-waveform',
    'mic', 'mic-off', 'video', 'video-off', 'camera', 'camera-off',
    'image', 'images', 'film', 'clapperboard', 'projector',
    'radio', 'tv', 'monitor', 'disc', 'disc-3', 'cassette-tape',
    'speaker', 'podcast', 'aperture', 'focus', 'list-music',
  ],
  communication: [
    'mail', 'mail-open', 'mail-plus', 'mail-check', 'send', 'inbox',
    'message-circle', 'message-square', 'messages-square', 'message-circle-heart',
    'phone', 'phone-call', 'phone-off', 'phone-incoming', 'phone-outgoing',
    'at-sign', 'bell', 'bell-off', 'bell-ring',
    'megaphone', 'speech', 'rss', 'voicemail', 'reply', 'forward',
    'wifi', 'wifi-off', 'bluetooth', 'antenna', 'satellite-dish',
  ],
  files: [
    'file', 'file-text', 'file-plus', 'file-minus', 'file-check', 'file-x',
    'files', 'file-code', 'file-image', 'file-video', 'file-audio', 'file-spreadsheet',
    'folder', 'folder-open', 'folder-plus', 'folder-check', 'folders',
    'archive', 'save', 'download', 'upload',
    'clipboard', 'clipboard-check', 'clipboard-list', 'copy', 'scissors', 'paperclip',
    'printer', 'book', 'book-open', 'notebook', 'newspaper', 'sticky-note',
    'database', 'hard-drive', 'server', 'cloud-upload', 'cloud-download',
  ],
  commerce: [
    'shopping-cart', 'shopping-bag', 'shopping-basket', 'store',
    'credit-card', 'wallet', 'banknote', 'coins', 'piggy-bank', 'hand-coins',
    'dollar-sign', 'euro', 'pound-sterling', 'japanese-yen', 'indian-rupee', 'bitcoin',
    'receipt', 'tag', 'tags', 'package', 'package-open', 'truck', 'gift',
    'percent', 'ticket', 'barcode', 'qr-code', 'calculator', 'briefcase', 'scale',
  ],
  social: [
    'heart', 'thumbs-up', 'thumbs-down', 'star', 'bookmark', 'share-2',
    'smile', 'frown', 'meh', 'laugh', 'angry',
    'user', 'users', 'user-round', 'user-check', 'user-plus', 'user-minus',
    'hand-heart', 'handshake', 'party-popper',
    'award', 'trophy', 'crown', 'flame', 'sparkles', 'gem', 'medal',
  ],
  weather: [
    'sun', 'moon', 'cloud', 'cloudy', 'cloud-rain', 'cloud-snow',
    'cloud-lightning', 'cloud-drizzle', 'cloud-fog', 'cloud-hail',
    'cloud-sun', 'cloud-moon', 'sunrise', 'sunset', 'sun-dim', 'moon-star',
    'wind', 'snowflake', 'umbrella', 'thermometer', 'droplet', 'droplets',
    'rainbow', 'tornado', 'haze',
  ],
  nature: [
    'leaf', 'trees', 'tree-pine', 'tree-deciduous', 'flower', 'flower-2', 'sprout',
    'bird', 'fish', 'cat', 'dog', 'rabbit', 'turtle', 'squirrel', 'paw-print',
    'shell', 'mountain', 'mountain-snow', 'waves', 'feather',
    'apple', 'cherry', 'carrot', 'wheat', 'egg', 'bone', 'footprints', 'tent',
  ],
  symbols: [
    'star', 'heart', 'circle', 'square', 'triangle', 'hexagon', 'octagon', 'diamond',
    'plus', 'minus', 'asterisk', 'hash', 'infinity', 'sigma', 'pi', 'ampersand',
    'copyright', 'badge-check', 'zap', 'lightbulb', 'atom', 'biohazard', 'radiation',
    'recycle', 'ban', 'anchor', 'crosshair', 'target', 'puzzle', 'rocket',
    'globe', 'map-pin', 'flag', 'compass', 'key-round', 'cake', 'graduation-cap',
    'stethoscope', 'wrench', 'hammer', 'plug', 'battery-full', 'cpu', 'brain',
  ],
};

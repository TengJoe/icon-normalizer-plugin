import {loadPixbuf} from '../../extension/lib/engine/load.js';
import {resizeLanczos} from '../../extension/lib/engine/render.js';
import GLib from 'gi://GLib';
const [src, out, w, h] = ARGV;
const pb = loadPixbuf(src);
const resized = resizeLanczos(pb, Number(w), Number(h));
resized.savev(out, 'png', [], []);
print(JSON.stringify({from: [pb.get_width(), pb.get_height()], to: [resized.get_width(), resized.get_height()]}));
import {loadPixbuf} from '../../extension/lib/engine/load.js';
const [src, out] = ARGV;
const pb = loadPixbuf(src);
pb.savev(out, 'png', [], []);
print(JSON.stringify({w: pb.get_width(), h: pb.get_height(), ch: pb.get_n_channels()}));
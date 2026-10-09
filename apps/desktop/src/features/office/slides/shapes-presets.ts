import type { ShapeKind } from './deck.ts'
import type { GeometryDefinition } from './shapes-geometry.ts'

/*
 * Every preset Herald draws, as DrawingML's preset definitions give it: its adjust values with
 * their defaults, its guides, its paths (with the parts PowerPoint shades or leaves unfilled), and
 * its text rectangle. Written in the formula language shapes-geometry.ts works out.
 */

const ELLIPSE = 'M l vc A wd2 hd2 cd2 cd4 A wd2 hd2 3cd4 cd4 A wd2 hd2 0 cd4 A wd2 hd2 cd4 cd4 Z'

/** The rectangle inside an ellipse, where its text goes. */
const INSCRIBED = 'idx cos wd2 2700000; idy sin hd2 2700000; il +- hc 0 idx; ir +- hc idx 0; it +- vc 0 idy; ib +- vc idy 0'

const SQUARE = 'M 0 0 L 1 0 L 1 1 L 0 1 Z'

/** Where a callout's tail meets its box: the tip on the side it points past, a notch of no width on the others. */
const TAIL = [
  'dxPos */ w adj1 100000; dyPos */ h adj2 100000; xPos +- hc dxPos 0; yPos +- vc dyPos 0',
  'dx */ dxPos h w; dy */ dyPos 1 1; adx abs dx; ady abs dy; dq +- adx 0 ady',
  'xg1 ?: dxPos 7 2; xg2 ?: dxPos 10 5; x1 */ w xg1 12; x2 */ w xg2 12',
  'yg1 ?: dyPos 7 2; yg2 ?: dyPos 10 5; y1 */ h yg1 12; y2 */ h yg2 12',
  't1 ?: dxPos l xPos; xl ?: dq t1 l; t2 ?: dyPos x1 xPos; xt ?: dq x1 t2',
  't3 ?: dxPos xPos r; xr ?: dq t3 r; t4 ?: dyPos xPos x1; xb ?: dq x1 t4',
  't5 ?: dxPos y1 yPos; yl ?: dq t5 y1; t6 ?: dyPos t yPos; yt ?: dq t t6',
  't7 ?: dxPos yPos y1; yr ?: dq t7 y1; t8 ?: dyPos yPos b; yb ?: dq b t8'
].join('; ')

const CLOUD = [
  'M 3900 14370 A 6753 9190 -11429249 7426832 A 5333 7267 -8646143 5396714 A 4365 5945 -8748475 5983381',
  'A 4857 6595 -7859164 7034504 A 5333 7273 -4722533 6541615 A 6775 9220 -2776035 7816140 A 5785 7867 37501 6842000',
  'A 6752 9215 1347096 6910353 A 7720 10543 3974558 4542661 A 4360 5918 -16496525 8804134 A 4345 5945 -14809710 9151131 Z'
].join(' ')

/** The lines inside a cloud where its puffs overlap. */
const CLOUD_LINES = [
  'M 4693 26177 A 4345 5945 5204520 1585770 M 6928 34899 A 4360 5918 4416628 686848 M 16478 39090 A 6752 9215 8257449 844866',
  'M 28827 34751 A 6752 9215 387196 959901 M 34129 22954 A 5785 7867 -4217541 4255042 M 41798 15354 A 5333 7273 1819082 1665090',
  'M 38324 5426 A 4857 6595 -924596 1096122 M 29078 3952 A 4857 6595 -8876540 1017354 M 22141 4720 A 4365 5945 -9724185 975759',
  'M 14000 5192 A 6753 9190 -4005873 1000000 M 4127 15789 A 6753 9190 9459075 648491'
].join(' ')

const CLOUD_TEXT = 'il */ w 2977 21600; it */ h 3262 21600; ir */ w 17087 21600; ib */ h 17337 21600'

export const PRESETS: Record<ShapeKind, GeometryDefinition> = {
  rect: { paths: ['M l t L r t L r b L l b Z'] },
  roundRect: {
    av: { adj: 16667 },
    gd: 'a pin 0 adj 50000; dx1 */ ss a 100000; x2 +- r 0 dx1; y2 +- b 0 dx1; il */ dx1 29289 100000; ir +- r 0 il; ib +- b 0 il',
    paths: ['M l dx1 A dx1 dx1 cd2 cd4 L x2 t A dx1 dx1 3cd4 cd4 L r y2 A dx1 dx1 0 cd4 L dx1 b A dx1 dx1 cd4 cd4 Z'],
    text: 'il il ir ib'
  },
  ellipse: { gd: INSCRIBED, paths: [ELLIPSE], text: 'il it ir ib' },
  triangle: { av: { adj: 50000 }, gd: 'a pin 0 adj 100000; x1 */ w a 200000; x2 */ w a 100000; x3 +- x1 wd2 0', paths: ['M l b L x2 t L r b Z'], text: 'x1 vc x3 b' },
  rtTriangle: { gd: 'it */ h 7 12; ir */ w 7 12; ib */ h 11 12', paths: ['M l b L l t L r b Z'], text: 'l it ir ib' },
  diamond: { gd: 'ir */ w 3 4; ib */ h 3 4', paths: ['M l vc L hc t L r vc L hc b Z'], text: 'wd4 hd4 ir ib' },
  parallelogram: {
    av: { adj: 25000 },
    gd: 'maxAdj */ 100000 w ss; a pin 0 adj maxAdj; x2 */ ss a 100000; x5 +- r 0 x2; q1 */ 5 a maxAdj; q2 +/ 1 q1 12; il */ q2 w 1; it */ q2 h 1; ir +- r 0 il; ib +- b 0 it',
    paths: ['M l b L x2 t L r t L x5 b Z'],
    text: 'il it ir ib'
  },
  trapezoid: {
    av: { adj: 25000 },
    gd: 'maxAdj */ 50000 w ss; a pin 0 adj maxAdj; x2 */ ss a 100000; x3 +- r 0 x2; il */ wd3 a maxAdj; it */ hd3 a maxAdj; ir +- r 0 il',
    paths: ['M l b L x2 t L x3 t L r b Z'],
    text: 'il it ir b'
  },
  pentagon: {
    av: { hf: 105146, vf: 110557 },
    gd: 'swd2 */ wd2 hf 100000; shd2 */ hd2 vf 100000; svc */ vc vf 100000; dx1 cos swd2 1080000; dx2 cos swd2 18360000; dy1 sin shd2 1080000; dy2 sin shd2 18360000; x1 +- hc 0 dx1; x2 +- hc 0 dx2; x3 +- hc dx2 0; x4 +- hc dx1 0; y1 +- svc 0 dy1; y2 +- svc 0 dy2; it */ y1 dx2 dx1',
    paths: ['M x1 y1 L hc t L x4 y1 L x3 y2 L x2 y2 Z'],
    text: 'x2 it x3 y2'
  },
  hexagon: {
    av: { adj: 25000, vf: 115470 },
    gd: 'maxAdj */ 50000 w ss; a pin 0 adj maxAdj; shd2 */ hd2 vf 100000; x1 */ ss a 100000; x2 +- r 0 x1; dy1 sin shd2 3600000; y1 +- vc 0 dy1; y2 +- vc dy1 0; q1 */ maxAdj -1 2; q2 +- a q1 0; q3 ?: q2 4 2; q4 ?: q2 3 2; q5 ?: q2 q1 0; q6 +/ a q5 q1; q7 */ q6 q4 -1; q8 +- q3 q7 0; il */ w q8 24; it */ h q8 24; ir +- r 0 il; ib +- b 0 it',
    paths: ['M l vc L x1 y1 L x2 y1 L r vc L x2 y2 L x1 y2 Z'],
    text: 'il it ir ib'
  },
  octagon: {
    av: { adj: 29289 },
    gd: 'a pin 0 adj 50000; x1 */ ss a 100000; x2 +- r 0 x1; y2 +- b 0 x1; il */ x1 1 2; ir +- r 0 il; ib +- b 0 il',
    paths: ['M l x1 L x1 t L x2 t L r x1 L r y2 L x2 b L x1 b L l y2 Z'],
    text: 'il il ir ib'
  },
  plus: {
    av: { adj: 25000 },
    gd: 'a pin 0 adj 50000; x1 */ ss a 100000; x2 +- r 0 x1; y2 +- b 0 x1; d +- w 0 h; il ?: d l x1; ir ?: d r x2; it ?: d x1 t; ib ?: d y2 b',
    paths: ['M l x1 L x1 x1 L x1 t L x2 t L x2 x1 L r x1 L r y2 L x2 y2 L x2 b L x1 b L x1 y2 L l y2 Z'],
    text: 'il it ir ib'
  },
  star5: {
    av: { adj: 19098, hf: 105146, vf: 110557 },
    gd: 'a pin 0 adj 50000; swd2 */ wd2 hf 100000; shd2 */ hd2 vf 100000; svc */ vc vf 100000; dx1 cos swd2 1080000; dx2 cos swd2 18360000; dy1 sin shd2 1080000; dy2 sin shd2 18360000; x1 +- hc 0 dx1; x2 +- hc 0 dx2; x3 +- hc dx2 0; x4 +- hc dx1 0; y1 +- svc 0 dy1; y2 +- svc 0 dy2; iwd2 */ swd2 a 50000; ihd2 */ shd2 a 50000; sdx1 cos iwd2 20520000; sdx2 cos iwd2 3240000; sdy1 sin ihd2 3240000; sdy2 sin ihd2 20520000; sx1 +- hc 0 sdx1; sx2 +- hc 0 sdx2; sx3 +- hc sdx2 0; sx4 +- hc sdx1 0; sy1 +- svc 0 sdy1; sy2 +- svc 0 sdy2; sy3 +- svc ihd2 0',
    paths: ['M x1 y1 L sx2 sy1 L hc t L sx3 sy1 L x4 y1 L sx4 sy2 L x3 y2 L hc sy3 L x2 y2 L sx1 sy2 Z'],
    text: 'sx1 sy1 sx4 sy3'
  },
  rightArrow: {
    av: { adj1: 50000, adj2: 50000 },
    gd: 'maxAdj2 */ 100000 w ss; a1 pin 0 adj1 100000; a2 pin 0 adj2 maxAdj2; dx1 */ ss a2 100000; x1 +- r 0 dx1; dy1 */ h a1 200000; y1 +- vc 0 dy1; y2 +- vc dy1 0; dx2 */ y1 dx1 hd2; x2 +- x1 dx2 0',
    paths: ['M l y1 L x1 y1 L x1 t L r vc L x1 b L x1 y2 L l y2 Z'],
    text: 'l y1 x2 y2'
  },
  leftArrow: {
    av: { adj1: 50000, adj2: 50000 },
    gd: 'maxAdj2 */ 100000 w ss; a1 pin 0 adj1 100000; a2 pin 0 adj2 maxAdj2; dx2 */ ss a2 100000; x2 +- l dx2 0; dy1 */ h a1 200000; y1 +- vc 0 dy1; y2 +- vc dy1 0; dx1 */ y1 dx2 hd2; x1 +- x2 0 dx1',
    paths: ['M l vc L x2 t L x2 y1 L r y1 L r y2 L x2 y2 L x2 b Z'],
    text: 'x1 y1 r y2'
  },
  upArrow: {
    av: { adj1: 50000, adj2: 50000 },
    gd: 'maxAdj2 */ 100000 h ss; a1 pin 0 adj1 100000; a2 pin 0 adj2 maxAdj2; dy2 */ ss a2 100000; y2 +- t dy2 0; dx1 */ w a1 200000; x1 +- hc 0 dx1; x2 +- hc dx1 0; dy1 */ x1 dy2 wd2; y1 +- y2 0 dy1',
    paths: ['M l y2 L hc t L r y2 L x2 y2 L x2 b L x1 b L x1 y2 Z'],
    text: 'x1 y1 x2 b'
  },
  downArrow: {
    av: { adj1: 50000, adj2: 50000 },
    gd: 'maxAdj2 */ 100000 h ss; a1 pin 0 adj1 100000; a2 pin 0 adj2 maxAdj2; dy1 */ ss a2 100000; y1 +- b 0 dy1; dx1 */ w a1 200000; x1 +- hc 0 dx1; x2 +- hc dx1 0; dy2 */ x1 dy1 wd2; y2 +- y1 dy2 0',
    paths: ['M l y1 L x1 y1 L x1 t L x2 t L x2 y1 L r y1 L hc b Z'],
    text: 'x1 t x2 y2'
  },
  leftRightArrow: {
    av: { adj1: 50000, adj2: 50000 },
    gd: 'maxAdj2 */ 50000 w ss; a1 pin 0 adj1 100000; a2 pin 0 adj2 maxAdj2; x2 */ ss a2 100000; x3 +- r 0 x2; dy */ h a1 200000; y1 +- vc 0 dy; y2 +- vc dy 0; dx1 */ y1 x2 hd2; x1 +- x2 0 dx1; x4 +- x3 dx1 0',
    paths: ['M l vc L x2 t L x2 y1 L x3 y1 L x3 t L r vc L x3 b L x3 y2 L x2 y2 L x2 b Z'],
    text: 'x1 y1 x4 y2'
  },
  chevron: {
    av: { adj: 50000 },
    gd: 'maxAdj */ 100000 w ss; a pin 0 adj maxAdj; x1 */ ss a 100000; x2 +- r 0 x1; dx +- x2 0 x1; il ?: dx x1 l; ir ?: dx x2 r',
    paths: ['M l t L x2 t L r vc L x2 b L l b L x1 vc Z'],
    text: 'il t ir b'
  },
  homePlate: {
    av: { adj: 50000 },
    gd: 'maxAdj */ 100000 w ss; a pin 0 adj maxAdj; dx1 */ ss a 100000; x1 +- r 0 dx1; ir +/ x1 r 2',
    paths: ['M l t L x1 t L r vc L x1 b L l b Z'],
    text: 'l t ir b'
  },
  wedgeRectCallout: {
    av: { adj1: -20833, adj2: 62500 },
    gd: TAIL,
    paths: ['M l t L x1 t L xt yt L x2 t L r t L r y1 L xr yr L r y2 L r b L x2 b L xb yb L x1 b L l b L l y2 L xl yl L l y1 Z']
  },
  wedgeRoundRectCallout: {
    av: { adj1: -20833, adj2: 62500, adj3: 16667 },
    gd: `${TAIL}; u1 */ ss adj3 100000; u2 +- r 0 u1; v2 +- b 0 u1; il */ u1 29289 100000; ir +- r 0 il; ib +- b 0 il`,
    paths: ['M l u1 A u1 u1 cd2 cd4 L x1 t L xt yt L x2 t L u2 t A u1 u1 3cd4 cd4 L r y1 L xr yr L r y2 L r v2 A u1 u1 0 cd4 L x2 b L xb yb L x1 b L u1 b A u1 u1 cd4 cd4 L l y2 L xl yl L l y1 Z'],
    text: 'il il ir ib'
  },
  snip1Rect: {
    av: { adj: 16667 },
    gd: 'a pin 0 adj 50000; dx1 */ ss a 100000; x1 +- r 0 dx1; it */ dx1 1 2; ir +/ x1 r 2',
    paths: ['M l t L x1 t L r dx1 L r b L l b Z'],
    text: 'l it ir b'
  },
  snip2SameRect: {
    av: { adj1: 16667, adj2: 0 },
    gd: 'a1 pin 0 adj1 50000; a2 pin 0 adj2 50000; tx1 */ ss a1 100000; tx2 +- r 0 tx1; bx1 */ ss a2 100000; bx2 +- r 0 bx1; by1 +- b 0 bx1; d +- tx1 0 bx1; tdx */ tx1 1 2; bdx */ bx1 1 2; il ?: d tdx bdx; ir +- r 0 il; ib +- b 0 bdx',
    paths: ['M tx1 t L tx2 t L r tx1 L r by1 L bx2 b L bx1 b L l by1 L l tx1 Z'],
    text: 'il tdx ir ib'
  },
  round1Rect: {
    av: { adj: 16667 },
    gd: 'a pin 0 adj 50000; dx1 */ ss a 100000; x1 +- r 0 dx1; idx */ dx1 29289 100000; ir +- r 0 idx',
    paths: ['M l t L x1 t A dx1 dx1 3cd4 cd4 L r b L l b Z'],
    text: 'l t ir b'
  },
  round2SameRect: {
    av: { adj1: 16667, adj2: 0 },
    gd: 'a1 pin 0 adj1 50000; a2 pin 0 adj2 50000; tx1 */ ss a1 100000; tx2 +- r 0 tx1; bx1 */ ss a2 100000; bx2 +- r 0 bx1; by1 +- b 0 bx1; d +- tx1 0 bx1; tdx */ tx1 29289 100000; bdx */ bx1 29289 100000; il ?: d tdx bdx; ir +- r 0 il; ib +- b 0 bdx',
    paths: ['M tx1 t L tx2 t A tx1 tx1 3cd4 cd4 L r by1 A bx1 bx1 0 cd4 L bx1 b A bx1 bx1 cd4 cd4 L l tx1 A tx1 tx1 cd2 cd4 Z'],
    text: 'il tdx ir ib'
  },
  plaque: {
    av: { adj: 16667 },
    gd: 'a pin 0 adj 50000; x1 */ ss a 100000; x2 +- r 0 x1; y2 +- b 0 x1; il */ x1 70711 100000; ir +- r 0 il; ib +- b 0 il',
    paths: ['M l x1 A x1 x1 cd4 -5400000 L x2 t A x1 x1 cd2 -5400000 L r y2 A x1 x1 3cd4 -5400000 L x1 b A x1 x1 0 -5400000 Z'],
    text: 'il il ir ib'
  },
  foldedCorner: {
    av: { adj: 16667 },
    gd: 'a pin 0 adj 50000; dy2 */ ss a 100000; dy1 */ dy2 1 5; x1 +- r 0 dy2; x2 +- x1 dy1 0; y2 +- b 0 dy2; y1 +- y2 dy1 0',
    paths: [
      { d: 'M l t L r t L r y2 L x1 b L l b Z', stroke: false },
      { d: 'M x1 b L x2 y1 L r y2 Z', fill: 'darkenLess', stroke: false },
      { d: 'M x1 b L x2 y1 L r y2 L x1 b L l b L l t L r t L r y2', fill: 'none' }
    ],
    text: 'l t r y2'
  },
  frame: {
    av: { adj1: 12500 },
    gd: 'a1 pin 0 adj1 50000; x1 */ ss a1 100000; x4 +- r 0 x1; y4 +- b 0 x1',
    paths: [{ d: 'M l t L r t L r b L l b Z M x1 x1 L x1 y4 L x4 y4 L x4 x1 Z', evenOdd: true }],
    text: 'x1 x1 x4 y4'
  },
  halfFrame: {
    av: { adj1: 33333, adj2: 33333 },
    gd: 'maxAdj2 */ 100000 w ss; a2 pin 0 adj2 maxAdj2; x1 */ ss a2 100000; g1 */ h x1 w; g2 +- h 0 g1; maxAdj1 */ 100000 g2 ss; a1 pin 0 adj1 maxAdj1; y1 */ ss a1 100000; dx2 */ y1 w h; x2 +- r 0 dx2; dy2 */ x1 h w; y2 +- b 0 dy2',
    paths: ['M l t L r t L x2 y1 L x1 y1 L x1 y2 L l b Z']
  },
  corner: {
    av: { adj1: 50000, adj2: 50000 },
    gd: 'maxAdj1 */ 100000 h ss; maxAdj2 */ 100000 w ss; a1 pin 0 adj1 maxAdj1; a2 pin 0 adj2 maxAdj2; x1 */ ss a2 100000; dy1 */ ss a1 100000; y1 +- b 0 dy1; d +- w 0 h; it ?: d y1 t; ir ?: d r x1',
    paths: ['M l t L x1 t L x1 y1 L r y1 L r b L l b Z'],
    text: 'l it ir b'
  },
  diagStripe: {
    av: { adj: 50000 },
    gd: 'a pin 0 adj 100000; x2 */ w a 100000; x3 +/ x2 r 2; y2 */ h a 100000; y3 +/ y2 b 2',
    paths: ['M l y2 L x2 t L r t L l b Z'],
    text: 'l t x3 y3'
  },
  bevel: {
    av: { adj: 12500 },
    gd: 'a pin 0 adj 50000; x1 */ ss a 100000; x2 +- r 0 x1; y2 +- b 0 x1',
    paths: [
      { d: 'M x1 x1 L x2 x1 L x2 y2 L x1 y2 Z', stroke: false },
      { d: 'M l t L r t L x2 x1 L x1 x1 Z', fill: 'lightenLess', stroke: false },
      { d: 'M l b L x1 y2 L x2 y2 L r b Z', fill: 'darkenLess', stroke: false },
      { d: 'M l t L x1 x1 L x1 y2 L l b Z', fill: 'lighten', stroke: false },
      { d: 'M r t L r b L x2 y2 L x2 x1 Z', fill: 'darken', stroke: false },
      { d: 'M l t L r t L r b L l b Z M x1 x1 L x2 x1 L x2 y2 L x1 y2 Z M l t L x1 x1 M l b L x1 y2 M r t L x2 x1 M r b L x2 y2', fill: 'none' }
    ],
    text: 'x1 x1 x2 y2'
  },
  heptagon: {
    av: { hf: 102572, vf: 105210 },
    gd: 'swd2 */ wd2 hf 100000; shd2 */ hd2 vf 100000; svc */ vc vf 100000; dx1 */ swd2 97493 100000; dx2 */ swd2 78183 100000; dx3 */ swd2 43388 100000; dy1 */ shd2 62349 100000; dy2 */ shd2 22252 100000; dy3 */ shd2 90097 100000; x1 +- hc 0 dx1; x2 +- hc 0 dx2; x3 +- hc 0 dx3; x4 +- hc dx3 0; x5 +- hc dx2 0; x6 +- hc dx1 0; y1 +- svc 0 dy1; y2 +- svc dy2 0; y3 +- svc dy3 0',
    paths: ['M x1 y2 L x2 y1 L hc t L x5 y1 L x6 y2 L x4 y3 L x3 y3 Z'],
    text: 'x2 y1 x5 y3'
  },
  decagon: {
    av: { vf: 105146 },
    gd: 'shd2 */ hd2 vf 100000; dx1 cos wd2 2160000; dx2 cos wd2 4320000; x1 +- hc 0 dx1; x2 +- hc 0 dx2; x3 +- hc dx2 0; x4 +- hc dx1 0; dy1 sin shd2 4320000; dy2 sin shd2 2160000; y1 +- vc 0 dy1; y2 +- vc 0 dy2; y3 +- vc dy2 0; y4 +- vc dy1 0',
    paths: ['M l vc L x1 y2 L x2 y1 L x3 y1 L x4 y2 L r vc L x4 y3 L x3 y4 L x2 y4 L x1 y3 Z'],
    text: 'x1 y2 x4 y3'
  },
  dodecagon: {
    gd: 'x1 */ w 2894 21600; x2 */ w 7906 21600; x3 */ w 13694 21600; x4 */ w 18706 21600; y1 */ h 2894 21600; y2 */ h 7906 21600; y3 */ h 13694 21600; y4 */ h 18706 21600',
    paths: ['M l y2 L x1 y1 L x2 t L x3 t L x4 y1 L r y2 L r y3 L x4 y4 L x3 b L x2 b L x1 y4 L l y3 Z'],
    text: 'x1 y1 x4 y4'
  },
  star4: {
    av: { adj: 12500 },
    gd: 'a pin 0 adj 50000; iwd2 */ wd2 a 50000; ihd2 */ hd2 a 50000; sdx cos iwd2 2700000; sdy sin ihd2 2700000; sx1 +- hc 0 sdx; sx2 +- hc sdx 0; sy1 +- vc 0 sdy; sy2 +- vc sdy 0',
    paths: ['M l vc L sx1 sy1 L hc t L sx2 sy1 L r vc L sx2 sy2 L hc b L sx1 sy2 Z'],
    text: 'sx1 sy1 sx2 sy2'
  },
  star6: {
    av: { adj: 28868, hf: 115470 },
    gd: 'a pin 0 adj 50000; swd2 */ wd2 hf 100000; dx1 cos swd2 1800000; x1 +- hc 0 dx1; x2 +- hc dx1 0; y2 +- vc hd4 0; iwd2 */ swd2 a 50000; ihd2 */ hd2 a 50000; sdx2 */ iwd2 1 2; sx1 +- hc 0 iwd2; sx2 +- hc 0 sdx2; sx3 +- hc sdx2 0; sx4 +- hc iwd2 0; sdy1 sin ihd2 3600000; sy1 +- vc 0 sdy1; sy2 +- vc sdy1 0',
    paths: ['M x1 hd4 L sx2 sy1 L hc t L sx3 sy1 L x2 hd4 L sx4 vc L x2 y2 L sx3 sy2 L hc b L sx2 sy2 L x1 y2 L sx1 vc Z'],
    text: 'sx1 sy1 sx4 sy2'
  },
  star8: {
    av: { adj: 38250 },
    gd: 'a pin 0 adj 50000; dx1 cos wd2 2700000; x1 +- hc 0 dx1; x2 +- hc dx1 0; dy1 sin hd2 2700000; y1 +- vc 0 dy1; y2 +- vc dy1 0; iwd2 */ wd2 a 50000; ihd2 */ hd2 a 50000; sdx1 */ iwd2 92388 100000; sdx2 */ iwd2 38268 100000; sdy1 */ ihd2 92388 100000; sdy2 */ ihd2 38268 100000; sx1 +- hc 0 sdx1; sx2 +- hc 0 sdx2; sx3 +- hc sdx2 0; sx4 +- hc sdx1 0; sy1 +- vc 0 sdy1; sy2 +- vc 0 sdy2; sy3 +- vc sdy2 0; sy4 +- vc sdy1 0',
    paths: ['M l vc L sx1 sy2 L x1 y1 L sx2 sy1 L hc t L sx3 sy1 L x2 y1 L sx4 sy2 L r vc L sx4 sy3 L x2 y2 L sx3 sy4 L hc b L sx2 sy4 L x1 y2 L sx1 sy3 Z'],
    text: 'sx1 sy1 sx4 sy4'
  },
  star10: {
    av: { adj: 42533, hf: 105146 },
    gd: 'a pin 0 adj 50000; swd2 */ wd2 hf 100000; dx1 */ swd2 95106 100000; dx2 */ swd2 58779 100000; x1 +- hc 0 dx1; x2 +- hc 0 dx2; x3 +- hc dx2 0; x4 +- hc dx1 0; dy1 */ hd2 80902 100000; dy2 */ hd2 30902 100000; y1 +- vc 0 dy1; y2 +- vc 0 dy2; y3 +- vc dy2 0; y4 +- vc dy1 0; iwd2 */ swd2 a 50000; ihd2 */ hd2 a 50000; sdx1 */ iwd2 80902 100000; sdx2 */ iwd2 30902 100000; sdy1 */ ihd2 95106 100000; sdy2 */ ihd2 58779 100000; sx1 +- hc 0 iwd2; sx2 +- hc 0 sdx1; sx3 +- hc 0 sdx2; sx4 +- hc sdx2 0; sx5 +- hc sdx1 0; sx6 +- hc iwd2 0; sy1 +- vc 0 sdy1; sy2 +- vc 0 sdy2; sy3 +- vc sdy2 0; sy4 +- vc sdy1 0',
    paths: ['M x1 y2 L sx2 sy2 L x2 y1 L sx3 sy1 L hc t L sx4 sy1 L x3 y1 L sx5 sy2 L x4 y2 L sx6 vc L x4 y3 L sx5 sy3 L x3 y4 L sx4 sy4 L hc b L sx3 sy4 L x2 y4 L sx2 sy3 L x1 y3 L sx1 vc Z'],
    text: 'sx2 sy2 sx5 sy3'
  },
  star12: {
    av: { adj: 37500 },
    gd: 'a pin 0 adj 50000; dx1 cos wd2 1800000; dy1 sin hd2 3600000; x1 +- hc 0 dx1; x3 */ w 3 4; x4 +- hc dx1 0; y1 +- vc 0 dy1; y3 */ h 3 4; y4 +- vc dy1 0; iwd2 */ wd2 a 50000; ihd2 */ hd2 a 50000; sdx1 cos iwd2 900000; sdx2 cos iwd2 2700000; sdx3 cos iwd2 4500000; sdy1 sin ihd2 4500000; sdy2 sin ihd2 2700000; sdy3 sin ihd2 900000; sx1 +- hc 0 sdx1; sx2 +- hc 0 sdx2; sx3 +- hc 0 sdx3; sx4 +- hc sdx3 0; sx5 +- hc sdx2 0; sx6 +- hc sdx1 0; sy1 +- vc 0 sdy1; sy2 +- vc 0 sdy2; sy3 +- vc 0 sdy3; sy4 +- vc sdy3 0; sy5 +- vc sdy2 0; sy6 +- vc sdy1 0',
    paths: ['M l vc L sx1 sy3 L x1 hd4 L sx2 sy2 L wd4 y1 L sx3 sy1 L hc t L sx4 sy1 L x3 y1 L sx5 sy2 L x4 hd4 L sx6 sy3 L r vc L sx6 sy4 L x4 y3 L sx5 sy5 L x3 y4 L sx4 sy6 L hc b L sx3 sy6 L wd4 y4 L sx2 sy5 L x1 y3 L sx1 sy4 Z'],
    text: 'sx2 sy2 sx5 sy5'
  },
  donut: {
    av: { adj: 25000 },
    gd: `a pin 0 adj 50000; dr */ ss a 100000; iwd2 +- wd2 0 dr; ihd2 +- hd2 0 dr; ${INSCRIBED}`,
    paths: [{ d: `${ELLIPSE} M dr vc A iwd2 ihd2 cd2 -5400000 A iwd2 ihd2 cd4 -5400000 A iwd2 ihd2 0 -5400000 A iwd2 ihd2 3cd4 -5400000 Z`, evenOdd: true }],
    text: 'il it ir ib'
  },
  noSmoking: {
    av: { adj: 18750 },
    gd: `a pin 0 adj 50000; dr */ ss a 100000; iwd2 +- wd2 0 dr; ihd2 +- hd2 0 dr; ang at2 w h; ct cos ihd2 ang; st sin iwd2 ang; m mod ct st 0; n */ iwd2 ihd2 m; drd2 */ dr 1 2; dang at2 n drd2; 2dang */ dang 2 1; swAng +- -10800000 2dang 0; t3 at2 w h; stAng1 +- t3 0 dang; stAng2 +- stAng1 0 cd2; ct1 cos ihd2 stAng1; st1 sin iwd2 stAng1; m1 mod ct1 st1 0; n1 */ iwd2 ihd2 m1; dx1 cos n1 stAng1; dy1 sin n1 stAng1; x1 +- hc dx1 0; y1 +- vc dy1 0; x2 +- hc 0 dx1; y2 +- vc 0 dy1; ${INSCRIBED}`,
    paths: [{ d: `${ELLIPSE} M x1 y1 A iwd2 ihd2 stAng1 swAng Z M x2 y2 A iwd2 ihd2 stAng2 swAng Z`, evenOdd: true }],
    text: 'il it ir ib'
  },
  blockArc: {
    av: { adj1: 10800000, adj2: 0, adj3: 25000 },
    gd: 'stAng pin 0 adj1 21599999; istAng pin 0 adj2 21599999; a3 pin 0 adj3 50000; sw11 +- istAng 0 stAng; sw12 +- sw11 21600000 0; swAng ?: sw11 sw11 sw12; iswAng +- 0 0 swAng; wt1 sin wd2 stAng; ht1 cos hd2 stAng; wt3 sin wd2 istAng; ht3 cos hd2 istAng; dx1 cat2 wd2 ht1 wt1; dy1 sat2 hd2 ht1 wt1; dx3 cat2 wd2 ht3 wt3; dy3 sat2 hd2 ht3 wt3; x1 +- hc dx1 0; y1 +- vc dy1 0; x3 +- hc dx3 0; y3 +- vc dy3 0; dr */ ss a3 100000; iwd2 +- wd2 0 dr; ihd2 +- hd2 0 dr; wt2 sin iwd2 istAng; ht2 cos ihd2 istAng; wt4 sin iwd2 stAng; ht4 cos ihd2 stAng; dx2 cat2 iwd2 ht2 wt2; dy2 sat2 ihd2 ht2 wt2; dx4 cat2 iwd2 ht4 wt4; dy4 sat2 ihd2 ht4 wt4; x2 +- hc dx2 0; y2 +- vc dy2 0; x4 +- hc dx4 0; y4 +- vc dy4 0; sw0 +- 21600000 0 stAng; da1 +- swAng 0 sw0; g1 max x1 x2; g2 max x3 x4; g3 max g1 g2; ir ?: da1 r g3; sw1 +- cd4 0 stAng; sw2 +- 27000000 0 stAng; sw3 ?: sw1 sw1 sw2; da2 +- swAng 0 sw3; g5 max y1 y2; g6 max y3 y4; g7 max g5 g6; ib ?: da2 b g7; sw4 +- cd2 0 stAng; sw5 +- 32400000 0 stAng; sw6 ?: sw4 sw4 sw5; da3 +- swAng 0 sw6; g9 min x1 x2; g10 min x3 x4; g11 min g9 g10; il ?: da3 l g11; sw7 +- 3cd4 0 stAng; sw8 +- 37800000 0 stAng; sw9 ?: sw7 sw7 sw8; da4 +- swAng 0 sw9; g13 min y1 y2; g14 min y3 y4; g15 min g13 g14; it ?: da4 t g15',
    paths: ['M x1 y1 A wd2 hd2 stAng swAng L x2 y2 A iwd2 ihd2 istAng iswAng Z'],
    text: 'il it ir ib'
  },
  pie: {
    av: { adj1: 0, adj2: 16200000 },
    gd: `stAng pin 0 adj1 21599999; enAng pin 0 adj2 21599999; sw1 +- enAng 0 stAng; sw2 +- sw1 21600000 0; swAng ?: sw1 sw1 sw2; wt1 sin wd2 stAng; ht1 cos hd2 stAng; dx1 cat2 wd2 ht1 wt1; dy1 sat2 hd2 ht1 wt1; x1 +- hc dx1 0; y1 +- vc dy1 0; ${INSCRIBED}`,
    paths: ['M x1 y1 A wd2 hd2 stAng swAng L hc vc Z'],
    text: 'il it ir ib'
  },
  chord: {
    av: { adj1: 2700000, adj2: 16200000 },
    gd: `stAng pin 0 adj1 21599999; enAng pin 0 adj2 21599999; sw1 +- enAng 0 stAng; sw2 +- sw1 21600000 0; swAng ?: sw1 sw1 sw2; wt1 sin wd2 stAng; ht1 cos hd2 stAng; dx1 cat2 wd2 ht1 wt1; dy1 sat2 hd2 ht1 wt1; x1 +- hc dx1 0; y1 +- vc dy1 0; ${INSCRIBED}`,
    paths: ['M x1 y1 A wd2 hd2 stAng swAng Z'],
    text: 'il it ir ib'
  },
  teardrop: {
    av: { adj: 100000 },
    gd: `a pin 0 adj 200000; r2 sqrt 2; tw */ r2 wd2 1; th */ r2 hd2 1; sw */ tw a 100000; sh */ th a 100000; dx1 cos sw 2700000; dy1 sin sh 2700000; x1 +- hc dx1 0; y1 +- vc 0 dy1; x2 +/ hc x1 2; y2 +/ vc y1 2; ${INSCRIBED}`,
    paths: ['M l vc A wd2 hd2 cd2 cd4 Q x2 t x1 y1 Q r y2 r vc A wd2 hd2 0 cd4 A wd2 hd2 cd4 cd4 Z'],
    text: 'il it ir ib'
  },
  heart: {
    gd: 'dx1 */ w 49 48; dx2 */ w 10 48; x1 +- hc 0 dx1; x2 +- hc 0 dx2; x3 +- hc dx2 0; x4 +- hc dx1 0; y1 +- t 0 hd3; il */ w 1 6; ir */ w 5 6; ib */ h 2 3',
    paths: ['M hc hd4 C x3 y1 x4 hd4 hc b C x1 hd4 x2 y1 hc hd4 Z'],
    text: 'il hd4 ir ib'
  },
  lightningBolt: {
    gd: 'x4 */ w 8757 21600; x9 */ w 13917 21600; y4 */ h 7437 21600; y10 */ h 14277 21600',
    paths: [{ d: 'M 8472 0 L 12860 6080 L 11050 6797 L 16577 12007 L 14767 12877 L 21600 21600 L 10012 14915 L 12222 13987 L 5022 9705 L 7602 8382 L 0 3890 Z', w: 21600, h: 21600 }],
    text: 'x4 y4 x9 y10'
  },
  sun: {
    av: { adj: 25000 },
    gd: 'a pin 12500 adj 46875; g0 +- 50000 0 a; g1 */ g0 30274 32768; g2 */ g0 12540 32768; g5 +- 50000 0 g1; g6 +- 50000 0 g2; g7 */ g0 23170 32768; g8 +- 50000 g7 0; g9 +- 50000 0 g7; g10 */ g5 3 4; g11 */ g6 3 4; g12 +- g10 3662 0; g13 +- g11 3662 0; g14 +- g11 12500 0; g15 +- 100000 0 g10; g16 +- 100000 0 g12; g17 +- 100000 0 g13; g18 +- 100000 0 g14; ox1 */ w 18436 21600; oy1 */ h 3163 21600; ox2 */ w 3163 21600; oy2 */ h 18436 21600; x8 */ w g8 100000; x9 */ w g9 100000; x10 */ w g10 100000; x12 */ w g12 100000; x13 */ w g13 100000; x14 */ w g14 100000; x15 */ w g15 100000; x16 */ w g16 100000; x17 */ w g17 100000; x18 */ w g18 100000; x19 */ w a 100000; wR */ w g0 100000; hR */ h g0 100000; y8 */ h g8 100000; y9 */ h g9 100000; y10 */ h g10 100000; y12 */ h g12 100000; y13 */ h g13 100000; y14 */ h g14 100000; y15 */ h g15 100000; y16 */ h g16 100000; y17 */ h g17 100000; y18 */ h g18 100000',
    paths: [
      'M r vc L x15 y18 L x15 y14 Z M ox1 oy1 L x16 y13 L x17 y12 Z M hc t L x18 y10 L x14 y10 Z M ox2 oy1 L x13 y12 L x12 y13 Z M l vc L x10 y14 L x10 y18 Z M ox2 oy2 L x12 y16 L x13 y17 Z M hc b L x14 y15 L x18 y15 Z M ox1 oy2 L x17 y16 L x16 y17 Z M x19 vc A wR hR cd2 21600000 Z'
    ],
    text: 'x9 y9 x8 y8'
  },
  moon: {
    av: { adj: 50000 },
    gd: 'a pin 0 adj 87500; g0 */ ss a 100000; g0w */ g0 w ss; g1 +- ss 0 g0; g2 */ g0 g0 g1; g3 */ ss ss g1; g4 */ g3 2 1; g5 +- g4 0 g2; g6 +- g5 0 g0; g6w */ g6 w ss; g7 */ g5 1 2; g8 +- g7 0 g0; dy1 */ g8 hd2 ss; g12 */ g0 9598 32768; g12w */ g12 w ss; g13 +- ss 0 g12; q1 */ ss ss 1; q2 */ g13 g13 1; q3 +- q1 0 q2; q4 sqrt q3; dy4 */ q4 hd2 ss; g15h +- vc 0 dy4; g16h +- vc dy4 0; g17w +- g6w 0 g0w; g18w */ g17w 1 2; dx2p +- g0w g18w w; dx2 */ dx2p -1 1; dy2 */ hd2 -1 1; stAng1 at2 dx2 dy2; enAngp1 at2 dx2 hd2; enAng1 +- enAngp1 0 21600000; swAng1 +- enAng1 0 stAng1',
    paths: ['M r b A w hd2 cd4 cd2 A g18w dy1 stAng1 swAng1 Z'],
    text: 'g12w g15h g0w g16h'
  },
  cloud: {
    gd: CLOUD_TEXT,
    paths: [
      { d: CLOUD, w: 43200, h: 43200 },
      { d: CLOUD_LINES, w: 43200, h: 43200, fill: 'none' }
    ],
    text: 'il it ir ib'
  },
  smileyFace: {
    av: { adj: 4653 },
    gd: `a pin -4653 adj 4653; x1 */ w 4969 21699; x2 */ w 6215 21600; x3 */ w 13135 21600; x4 */ w 16640 21600; y1 */ h 7570 21600; y3 */ h 16515 21600; dy2 */ h a 100000; y2 +- y3 0 dy2; y4 +- y3 dy2 0; dy3 */ h a 50000; y5 +- y4 dy3 0; wR */ w 1125 21600; hR */ h 1125 21600; ${INSCRIBED}`,
    paths: [
      'M l vc A wd2 hd2 cd2 21600000 Z',
      { d: 'M x2 y1 A wR hR cd2 21600000 M x3 y1 A wR hR cd2 21600000', fill: 'darkenLess' },
      { d: 'M x1 y2 Q hc y5 x4 y2', fill: 'none' },
      { d: 'M l vc A wd2 hd2 cd2 21600000 Z', fill: 'none' }
    ],
    text: 'il it ir ib'
  },
  can: {
    av: { adj: 25000 },
    gd: 'maxAdj */ 50000 h ss; a pin 0 adj maxAdj; y1 */ ss a 200000; y2 +- y1 y1 0; y3 +- b 0 y1',
    paths: [
      { d: 'M l y1 A wd2 y1 cd2 -10800000 L r y3 A wd2 y1 0 cd2 Z', stroke: false },
      { d: 'M l y1 A wd2 y1 cd2 cd2 A wd2 y1 0 cd2 Z', fill: 'lighten', stroke: false },
      { d: 'M r y1 A wd2 y1 0 cd2 A wd2 y1 cd2 cd2 L r y3 A wd2 y1 0 cd2 L l y1', fill: 'none' }
    ],
    text: 'l y2 r y3'
  },
  cube: {
    av: { adj: 25000 },
    gd: 'a pin 0 adj 100000; y1 */ ss a 100000; y4 +- b 0 y1; x4 +- r 0 y1',
    paths: [
      { d: 'M l y1 L x4 y1 L x4 b L l b Z', stroke: false },
      { d: 'M x4 y1 L r t L r y4 L x4 b Z', fill: 'darkenLess', stroke: false },
      { d: 'M l y1 L y1 t L r t L x4 y1 Z', fill: 'lightenLess', stroke: false },
      { d: 'M l y1 L y1 t L r t L r y4 L x4 b L l b Z M l y1 L x4 y1 L r t M x4 y1 L x4 b', fill: 'none' }
    ],
    text: 'l y1 x4 b'
  },
  bracketPair: {
    av: { adj: 16667 },
    gd: 'a pin 0 adj 50000; x1 */ ss a 100000; x2 +- r 0 x1; y2 +- b 0 x1; il */ x1 29289 100000; ir +- r 0 il; ib +- b 0 il',
    paths: [
      { d: 'M l x1 A x1 x1 cd2 cd4 L x2 t A x1 x1 3cd4 cd4 L r y2 A x1 x1 0 cd4 L x1 b A x1 x1 cd4 cd4 Z', stroke: false },
      { d: 'M x1 b A x1 x1 cd4 cd4 L l x1 A x1 x1 cd2 cd4 M x2 t A x1 x1 3cd4 cd4 L r y2 A x1 x1 0 cd4', fill: 'none' }
    ],
    text: 'il il ir ib'
  },
  bracePair: {
    av: { adj: 8333 },
    gd: 'a pin 0 adj 25000; x1 */ ss a 100000; x2 */ ss a 50000; x3 +- r 0 x2; x4 +- r 0 x1; y2 +- vc 0 x1; y3 +- vc x1 0; y4 +- b 0 x1; it */ x1 29289 100000; il +- x1 it 0; ir +- r 0 il; ib +- b 0 it',
    paths: [
      {
        d: 'M x2 b A x1 x1 cd4 cd4 L x1 y3 A x1 x1 0 -5400000 A x1 x1 cd4 -5400000 L x1 x1 A x1 x1 cd2 cd4 L x3 t A x1 x1 3cd4 cd4 L x4 y2 A x1 x1 cd2 -5400000 A x1 x1 3cd4 -5400000 L x4 y4 A x1 x1 0 cd4 Z',
        stroke: false
      },
      {
        d: 'M x2 b A x1 x1 cd4 cd4 L x1 y3 A x1 x1 0 -5400000 A x1 x1 cd4 -5400000 L x1 x1 A x1 x1 cd2 cd4 M x3 t A x1 x1 3cd4 cd4 L x4 y2 A x1 x1 cd2 -5400000 A x1 x1 3cd4 -5400000 L x4 y4 A x1 x1 0 cd4',
        fill: 'none'
      }
    ],
    text: 'il il ir ib'
  },
  leftBracket: {
    av: { adj: 8333 },
    gd: 'maxAdj */ 50000 h ss; a pin 0 adj maxAdj; y1 */ ss a 100000; dx1 cos w 2700000; dy1 sin y1 2700000; il +- r 0 dx1; it +- y1 0 dy1; ib +- b dy1 y1',
    paths: [
      { d: 'M r b A w y1 cd4 cd4 L l y1 A w y1 cd2 cd4 Z', stroke: false },
      { d: 'M r b A w y1 cd4 cd4 L l y1 A w y1 cd2 cd4', fill: 'none' }
    ],
    text: 'il it r ib'
  },
  rightBracket: {
    av: { adj: 8333 },
    gd: 'maxAdj */ 50000 h ss; a pin 0 adj maxAdj; y1 */ ss a 100000; y2 +- b 0 y1; dx1 cos w 2700000; dy1 sin y1 2700000; ir +- l dx1 0; it +- y1 0 dy1; ib +- b dy1 y1',
    paths: [
      { d: 'M l t A w y1 3cd4 cd4 L r y2 A w y1 0 cd4 Z', stroke: false },
      { d: 'M l t A w y1 3cd4 cd4 L r y2 A w y1 0 cd4', fill: 'none' }
    ],
    text: 'l it ir ib'
  },
  leftBrace: {
    av: { adj1: 8333, adj2: 50000 },
    gd: 'a2 pin 0 adj2 100000; q1 +- 100000 0 a2; q2 min q1 a2; q3 */ q2 1 2; maxAdj1 */ q3 h ss; a1 pin 0 adj1 maxAdj1; y1 */ ss a1 100000; y3 */ h a2 100000; y4 +- y3 y1 0; dx1 cos wd2 2700000; dy1 sin y1 2700000; il +- r 0 dx1; it +- y1 0 dy1; ib +- b dy1 y1',
    paths: [
      { d: 'M r b A wd2 y1 cd4 cd4 L hc y4 A wd2 y1 0 -5400000 A wd2 y1 cd4 -5400000 L hc y1 A wd2 y1 cd2 cd4 Z', stroke: false },
      { d: 'M r b A wd2 y1 cd4 cd4 L hc y4 A wd2 y1 0 -5400000 A wd2 y1 cd4 -5400000 L hc y1 A wd2 y1 cd2 cd4', fill: 'none' }
    ],
    text: 'il it r ib'
  },
  rightBrace: {
    av: { adj1: 8333, adj2: 50000 },
    gd: 'a2 pin 0 adj2 100000; q1 +- 100000 0 a2; q2 min q1 a2; q3 */ q2 1 2; maxAdj1 */ q3 h ss; a1 pin 0 adj1 maxAdj1; y1 */ ss a1 100000; y3 */ h a2 100000; y2 +- y3 0 y1; y4 +- b 0 y1; dx1 cos wd2 2700000; dy1 sin y1 2700000; ir +- l dx1 0; it +- y1 0 dy1; ib +- b dy1 y1',
    paths: [
      { d: 'M l t A wd2 y1 3cd4 cd4 L hc y2 A wd2 y1 cd2 -5400000 A wd2 y1 3cd4 -5400000 L hc y4 A wd2 y1 0 cd4 Z', stroke: false },
      { d: 'M l t A wd2 y1 3cd4 cd4 L hc y2 A wd2 y1 cd2 -5400000 A wd2 y1 3cd4 -5400000 L hc y4 A wd2 y1 0 cd4', fill: 'none' }
    ],
    text: 'l it ir ib'
  },
  upDownArrow: {
    av: { adj1: 50000, adj2: 50000 },
    gd: 'maxAdj2 */ 50000 h ss; a1 pin 0 adj1 100000; a2 pin 0 adj2 maxAdj2; y2 */ ss a2 100000; y3 +- b 0 y2; dx1 */ w a1 200000; x1 +- hc 0 dx1; x2 +- hc dx1 0; dy1 */ x1 y2 wd2; y1 +- y2 0 dy1; y4 +- y3 dy1 0',
    paths: ['M l y2 L hc t L r y2 L x2 y2 L x2 y3 L r y3 L hc b L l y3 L x1 y3 L x1 y2 Z'],
    text: 'x1 y1 x2 y4'
  },
  quadArrow: {
    av: { adj1: 22500, adj2: 22500, adj3: 22500 },
    gd: 'a2 pin 0 adj2 50000; maxAdj1 */ a2 2 1; a1 pin 0 adj1 maxAdj1; q1 +- 100000 0 maxAdj1; maxAdj3 */ q1 1 2; a3 pin 0 adj3 maxAdj3; x1 */ ss a3 100000; dx2 */ ss a2 100000; x2 +- hc 0 dx2; x5 +- hc dx2 0; dx3 */ ss a1 200000; x3 +- hc 0 dx3; x4 +- hc dx3 0; x6 +- r 0 x1; y2 +- vc 0 dx2; y5 +- vc dx2 0; y3 +- vc 0 dx3; y4 +- vc dx3 0; y6 +- b 0 x1; il */ dx3 x1 dx2; ir +- r 0 il',
    paths: ['M l vc L x1 y2 L x1 y3 L x3 y3 L x3 x1 L x2 x1 L hc t L x5 x1 L x4 x1 L x4 y3 L x6 y3 L x6 y2 L r vc L x6 y5 L x6 y4 L x4 y4 L x4 y6 L x5 y6 L hc b L x2 y6 L x3 y6 L x3 y4 L x1 y4 L x1 y5 Z'],
    text: 'il y3 ir y4'
  },
  notchedRightArrow: {
    av: { adj1: 50000, adj2: 50000 },
    gd: 'maxAdj2 */ 100000 w ss; a1 pin 0 adj1 100000; a2 pin 0 adj2 maxAdj2; dx2 */ ss a2 100000; x2 +- r 0 dx2; dy1 */ h a1 200000; y1 +- vc 0 dy1; y2 +- vc dy1 0; x1 */ dy1 dx2 hd2; x3 +- r 0 x1',
    paths: ['M l y1 L x2 y1 L x2 t L r vc L x2 b L x2 y2 L l y2 L x1 vc Z'],
    text: 'x1 y1 x3 y2'
  },
  stripedRightArrow: {
    av: { adj1: 50000, adj2: 50000 },
    gd: 'maxAdj2 */ 84375 w ss; a1 pin 0 adj1 100000; a2 pin 0 adj2 maxAdj2; x4 */ ss 5 32; dx5 */ ss a2 100000; x5 +- r 0 dx5; dy1 */ h a1 200000; y1 +- vc 0 dy1; y2 +- vc dy1 0; dx6 */ dy1 dx5 hd2; x6 +- r 0 dx6',
    paths: ['M l y1 L ssd32 y1 L ssd32 y2 L l y2 Z M ssd16 y1 L ssd8 y1 L ssd8 y2 L ssd16 y2 Z M x4 y1 L x5 y1 L x5 t L r vc L x5 b L x5 y2 L x4 y2 Z'],
    text: 'x4 y1 x6 y2'
  },
  bentArrow: {
    av: { adj1: 25000, adj2: 25000, adj3: 25000, adj4: 43750 },
    gd: 'a2 pin 0 adj2 50000; maxAdj1 */ a2 2 1; a1 pin 0 adj1 maxAdj1; a3 pin 0 adj3 50000; th */ ss a1 100000; aw2 */ ss a2 100000; th2 */ th 1 2; dh2 +- aw2 0 th2; ah */ ss a3 100000; bw +- r 0 ah; bh +- b 0 dh2; bs min bw bh; maxAdj4 */ 100000 bs ss; a4 pin 0 adj4 maxAdj4; bd */ ss a4 100000; bd3 +- bd 0 th; bd2 max bd3 0; x3 +- th bd2 0; x4 +- r 0 ah; y3 +- dh2 th 0; y4 +- y3 dh2 0; y5 +- dh2 bd 0',
    paths: ['M l b L l y5 A bd bd cd2 cd4 L x4 dh2 L x4 t L r aw2 L x4 y4 L x4 y3 L x3 y3 A bd2 bd2 3cd4 -5400000 L th b Z']
  },
  uturnArrow: {
    av: { adj1: 25000, adj2: 25000, adj3: 25000, adj4: 43750, adj5: 75000 },
    gd: 'a2 pin 0 adj2 25000; maxAdj1 */ a2 2 1; a1 pin 0 adj1 maxAdj1; q2 */ a1 ss h; q3 +- 100000 0 q2; maxAdj3 */ q3 h ss; a3 pin 0 adj3 maxAdj3; q1 +- a3 adj1 0; minAdj5 */ q1 ss h; a5 pin minAdj5 adj5 100000; th */ ss a1 100000; aw2 */ ss a2 100000; th2 */ th 1 2; dh2 +- aw2 0 th2; y5 */ h a5 100000; ah */ ss a3 100000; y4 +- y5 0 ah; x9 +- r 0 dh2; bw */ x9 1 2; bs min bw y4; maxAdj4 */ bs 100000 ss; a4 pin 0 adj4 maxAdj4; bd */ ss a4 100000; bd3 +- bd 0 th; bd2 max bd3 0; x3 +- th bd2 0; x8 +- r 0 aw2; x6 +- x8 0 aw2; x7 +- x6 dh2 0; x4 +- x9 0 bd; x5 +- x7 0 bd2',
    paths: ['M l b L l bd A bd bd cd2 cd4 L x4 t A bd bd 3cd4 cd4 L x9 y4 L r y4 L x8 y5 L x6 y4 L x7 y4 L x7 x3 A bd2 bd2 0 -5400000 L x3 th A bd2 bd2 3cd4 -5400000 L th b Z']
  },
  wedgeEllipseCallout: {
    av: { adj1: -20833, adj2: 62500 },
    gd: `dxPos */ w adj1 100000; dyPos */ h adj2 100000; xPos +- hc dxPos 0; yPos +- vc dyPos 0; sdx */ dxPos h 1; sdy */ dyPos w 1; pang at2 sdx sdy; stAng +- pang 660000 0; enAng +- pang 0 660000; dx1 cos wd2 stAng; dy1 sin hd2 stAng; x1 +- hc dx1 0; y1 +- vc dy1 0; dx2 cos wd2 enAng; dy2 sin hd2 enAng; x2 +- hc dx2 0; y2 +- vc dy2 0; stAng1 at2 dx1 dy1; enAng1 at2 dx2 dy2; swAng1 +- enAng1 0 stAng1; swAng2 +- swAng1 21600000 0; swAng ?: swAng1 swAng1 swAng2; ${INSCRIBED}`,
    paths: ['M xPos yPos L x1 y1 A wd2 hd2 stAng1 swAng Z'],
    text: 'il it ir ib'
  },
  cloudCallout: {
    av: { adj1: -20833, adj2: 62500 },
    gd: `dxPos */ w adj1 100000; dyPos */ h adj2 100000; xPos +- hc dxPos 0; yPos +- vc dyPos 0; ht cat2 hd2 dxPos dyPos; wt sat2 wd2 dxPos dyPos; g2 cat2 wd2 ht wt; g3 sat2 hd2 ht wt; g4 +- hc g2 0; g5 +- vc g3 0; g6 +- g4 0 xPos; g7 +- g5 0 yPos; g8 mod g6 g7 0; g9 */ ss 6600 21600; g10 +- g8 0 g9; g11 */ g10 1 3; g12 */ ss 1800 21600; g13 +- g11 g12 0; g14 */ g13 g6 g8; g15 */ g13 g7 g8; g16 +- g14 xPos 0; g17 +- g15 yPos 0; g18 */ ss 4800 21600; g19 */ g11 2 1; g20 +- g18 g19 0; g21 */ g20 g6 g8; g22 */ g20 g7 g8; g23 +- g21 xPos 0; g24 +- g22 yPos 0; g25 */ ss 1200 21600; g26 */ ss 600 21600; x23 +- xPos g26 0; x24 +- g16 g25 0; x25 +- g23 g12 0; ${CLOUD_TEXT}`,
    paths: [
      { d: CLOUD, w: 43200, h: 43200 },
      'M x23 yPos A g26 g26 0 21600000 Z M x24 g17 A g25 g25 0 21600000 Z M x25 g24 A g12 g12 0 21600000 Z',
      { d: CLOUD_LINES, w: 43200, h: 43200, fill: 'none' }
    ],
    text: 'il it ir ib'
  },
  mathPlus: {
    av: { adj1: 23520 },
    gd: 'a1 pin 0 adj1 73490; dx1 */ w 73490 200000; dy1 */ h 73490 200000; dx2 */ ss a1 200000; x1 +- hc 0 dx1; x2 +- hc 0 dx2; x3 +- hc dx2 0; x4 +- hc dx1 0; y1 +- vc 0 dy1; y2 +- vc 0 dx2; y3 +- vc dx2 0; y4 +- vc dy1 0',
    paths: ['M x1 y2 L x2 y2 L x2 y1 L x3 y1 L x3 y2 L x4 y2 L x4 y3 L x3 y3 L x3 y4 L x2 y4 L x2 y3 L x1 y3 Z'],
    text: 'x1 y2 x4 y3'
  },
  mathMinus: {
    av: { adj1: 23520 },
    gd: 'a1 pin 0 adj1 100000; dy1 */ h a1 200000; dx1 */ w 73490 200000; y1 +- vc 0 dy1; y2 +- vc dy1 0; x1 +- hc 0 dx1; x2 +- hc dx1 0',
    paths: ['M x1 y1 L x2 y1 L x2 y2 L x1 y2 Z'],
    text: 'x1 y1 x2 y2'
  },
  mathMultiply: {
    av: { adj1: 23520 },
    gd: 'a1 pin 0 adj1 51965; th */ ss a1 100000; a at2 w h; sa sin 1 a; ca cos 1 a; ta tan 1 a; dl mod w h 0; rw */ dl 51965 100000; lM +- dl 0 rw; xM */ ca lM 2; yM */ sa lM 2; dxAM */ sa th 2; dyAM */ ca th 2; xA +- xM 0 dxAM; yA +- yM dyAM 0; xB +- xM dxAM 0; yB +- yM 0 dyAM; xBC +- hc 0 xB; yBC */ xBC ta 1; yC +- yBC yB 0; xD +- r 0 xB; xE +- r 0 xA; yFE +- vc 0 yA; xFE */ yFE 1 ta; xF +- xE 0 xFE; xL +- xA xFE 0; yG +- b 0 yA; yH +- b 0 yB; yI +- b 0 yC',
    paths: ['M xA yA L xB yB L hc yC L xD yB L xE yA L xF vc L xE yG L xD yH L hc yI L xB yH L xA yG L xL vc Z'],
    text: 'xA yA xE yH'
  },
  mathDivide: {
    av: { adj1: 23520, adj2: 5880, adj3: 11760 },
    gd: 'a1 pin 1000 adj1 36745; q1 +- 100000 0 a1; ma3h */ q1 1 4; ma3w */ 36745 w h; maxAdj3 min ma3h ma3w; a3 pin 1000 adj3 maxAdj3; m4a3 */ -4 a3 1; q2 +- 100000 m4a3 a1; maxAdj2 */ q2 1 2; a2 pin 0 adj2 maxAdj2; dy1 */ h a1 200000; yg */ h a2 100000; rad */ h a3 100000; dx1 */ w 73490 200000; y3 +- vc 0 dy1; y4 +- vc dy1 0; a +- yg rad 0; y2 +- y3 0 a; y1 +- y2 0 rad; y5 +- b 0 y1; x1 +- hc 0 dx1; x3 +- hc dx1 0',
    paths: ['M hc y1 A rad rad 3cd4 21600000 Z M hc y5 A rad rad cd4 21600000 Z M x1 y3 L x3 y3 L x3 y4 L x1 y4 Z'],
    text: 'x1 y3 x3 y4'
  },
  mathEqual: {
    av: { adj1: 23520, adj2: 11760 },
    gd: 'a1 pin 0 adj1 36745; 2a1 */ a1 2 1; mAdj2 +- 100000 0 2a1; a2 pin 0 adj2 mAdj2; dy1 */ h a1 100000; dy2 */ h a2 200000; dx1 */ w 73490 200000; y2 +- vc 0 dy2; y3 +- vc dy2 0; y1 +- y2 0 dy1; y4 +- y3 dy1 0; x1 +- hc 0 dx1; x2 +- hc dx1 0',
    paths: ['M x1 y1 L x2 y1 L x2 y2 L x1 y2 Z M x1 y3 L x2 y3 L x2 y4 L x1 y4 Z'],
    text: 'x1 y1 x2 y4'
  },
  mathNotEqual: {
    av: { adj1: 23520, adj2: 6600000, adj3: 11760 },
    gd: 'a1 pin 0 adj1 50000; crAng pin 4200000 adj2 6600000; 2a1 */ a1 2 1; maxAdj3 +- 100000 0 2a1; a3 pin 0 adj3 maxAdj3; dy1 */ h a1 100000; dy2 */ h a3 200000; dx1 */ w 73490 200000; x1 +- hc 0 dx1; x8 +- hc dx1 0; y2 +- vc 0 dy2; y3 +- vc dy2 0; y1 +- y2 0 dy1; y4 +- y3 dy1 0; cadj2 +- crAng 0 cd4; xadj2 tan hd2 cadj2; len mod xadj2 hd2 0; bhw */ len dy1 hd2; bhw2 */ bhw 1 2; x7 +- hc xadj2 bhw2; dx67 */ xadj2 y1 hd2; x6 +- x7 0 dx67; dx57 */ xadj2 y2 hd2; x5 +- x7 0 dx57; dx47 */ xadj2 y3 hd2; x4 +- x7 0 dx47; dx37 */ xadj2 y4 hd2; x3 +- x7 0 dx37; rx7 +- x7 bhw 0; rx6 +- x6 bhw 0; rx5 +- x5 bhw 0; rx4 +- x4 bhw 0; rx3 +- x3 bhw 0; dx7 */ dy1 hd2 len; rxt +- x7 dx7 0; lxt +- rx7 0 dx7; rx ?: cadj2 rxt rx7; lx ?: cadj2 x7 lxt; dy3 */ dy1 xadj2 len; dy4 +- 0 0 dy3; ry ?: cadj2 dy3 t; ly ?: cadj2 t dy4; dlx +- w 0 rx; drx +- w 0 lx; dy5 +- h 0 ly; dy6 +- h 0 ry',
    paths: ['M x1 y1 L x6 y1 L lx ly L rx ry L rx6 y1 L x8 y1 L x8 y2 L rx5 y2 L rx4 y3 L x8 y3 L x8 y4 L rx3 y4 L drx dy5 L dlx dy6 L x3 y4 L x1 y4 L x1 y3 L x4 y3 L x5 y2 L x1 y2 Z'],
    text: 'x1 y1 x8 y4'
  },
  wave: {
    av: { adj1: 12500, adj2: 0 },
    gd: 'a1 pin 0 adj1 20000; a2 pin -10000 adj2 10000; y1 */ h a1 100000; dy2 */ y1 10 3; y2 +- y1 0 dy2; y3 +- y1 dy2 0; y4 +- b 0 y1; y5 +- y4 0 dy2; y6 +- y4 dy2 0; of2 */ w a2 50000; dx2 ?: of2 0 of2; x2 +- l 0 dx2; dx5 ?: of2 of2 0; x5 +- r 0 dx5; dx3 +/ dx2 x5 3; x3 +- x2 dx3 0; x4 +/ x3 x5 2; x6 +- l dx5 0; x10 +- r dx2 0; x7 +- x6 dx3 0; x8 +/ x7 x10 2; il max x2 x6; ir min x5 x10; it */ h a1 50000; ib +- b 0 it',
    paths: ['M x2 y1 C x3 y2 x4 y3 x5 y1 L x10 y4 C x8 y6 x7 y5 x6 y4 Z'],
    text: 'il it ir ib'
  },
  doubleWave: {
    av: { adj1: 6250, adj2: 0 },
    gd: 'a1 pin 0 adj1 12500; a2 pin -10000 adj2 10000; y1 */ h a1 100000; dy2 */ y1 10 3; y2 +- y1 0 dy2; y3 +- y1 dy2 0; y4 +- b 0 y1; y5 +- y4 0 dy2; y6 +- y4 dy2 0; of2 */ w a2 50000; dx2 ?: of2 0 of2; x2 +- l 0 dx2; dx8 ?: of2 of2 0; x8 +- r 0 dx8; dx3 +/ dx2 x8 6; x3 +- x2 dx3 0; dx4 +/ dx2 x8 3; x4 +- x2 dx4 0; x5 +/ x2 x8 2; x6 +- x5 dx3 0; x7 +/ x6 x8 2; x9 +- l dx8 0; x15 +- r dx2 0; x10 +- x9 dx3 0; x11 +- x9 dx4 0; x12 +/ x9 x15 2; x13 +- x12 dx3 0; x14 +/ x13 x15 2; il max x2 x9; ir min x8 x15; it */ h a1 50000; ib +- b 0 it',
    paths: ['M x2 y1 C x3 y2 x4 y3 x5 y1 C x6 y2 x7 y3 x8 y1 L x15 y4 C x14 y6 x13 y5 x12 y4 C x11 y6 x10 y5 x9 y4 Z'],
    text: 'il it ir ib'
  },
  flowChartProcess: { paths: [{ d: SQUARE, w: 1, h: 1 }] },
  flowChartAlternateProcess: {
    gd: 'x2 +- r 0 ssd6; y2 +- b 0 ssd6; il */ ssd6 29289 100000; ir +- r 0 il; ib +- b 0 il',
    paths: ['M l ssd6 A ssd6 ssd6 cd2 cd4 L x2 t A ssd6 ssd6 3cd4 cd4 L r y2 A ssd6 ssd6 0 cd4 L ssd6 b A ssd6 ssd6 cd4 cd4 Z'],
    text: 'il il ir ib'
  },
  flowChartDecision: { gd: 'ir */ w 3 4; ib */ h 3 4', paths: [{ d: 'M 0 1 L 1 0 L 2 1 L 1 2 Z', w: 2, h: 2 }], text: 'wd4 hd4 ir ib' },
  flowChartInputOutput: { gd: 'x5 */ w 4 5', paths: [{ d: 'M 0 5 L 1 0 L 5 0 L 4 5 Z', w: 5, h: 5 }], text: 'wd5 t x5 b' },
  flowChartPredefinedProcess: {
    gd: 'x2 */ w 7 8',
    paths: [
      { d: SQUARE, w: 1, h: 1, stroke: false },
      { d: 'M 1 0 L 1 8 M 7 0 L 7 8', w: 8, h: 8, fill: 'none' },
      { d: SQUARE, w: 1, h: 1, fill: 'none' }
    ],
    text: 'wd8 t x2 b'
  },
  flowChartInternalStorage: {
    paths: [
      { d: SQUARE, w: 1, h: 1, stroke: false },
      { d: 'M 1 0 L 1 8 M 0 1 L 8 1', w: 8, h: 8, fill: 'none' },
      { d: SQUARE, w: 1, h: 1, fill: 'none' }
    ],
    text: 'wd8 hd8 r b'
  },
  flowChartDocument: {
    gd: 'y1 */ h 17322 21600',
    paths: [{ d: 'M 0 0 L 21600 0 L 21600 17322 C 10800 17322 10800 23922 0 20172 Z', w: 21600, h: 21600 }],
    text: 'l t r y1'
  },
  flowChartMultidocument: {
    gd: 'y2 */ h 3675 21600; y8 */ h 20782 21600; x5 */ w 18595 21600',
    paths: [
      {
        d: 'M 0 20782 C 9298 23542 9298 18022 18595 18022 L 18595 3675 L 0 3675 Z M 1532 3675 L 1532 1815 L 20000 1815 L 20000 16252 C 19298 16252 18595 16352 18595 16352 L 18595 3675 Z M 2972 1815 L 2972 0 L 21600 0 L 21600 14392 C 20800 14392 20000 14467 20000 14467 L 20000 1815 Z',
        w: 21600,
        h: 21600,
        stroke: false
      },
      {
        d: 'M 0 3675 L 18595 3675 L 18595 18022 C 9298 18022 9298 23542 0 20782 Z M 1532 3675 L 1532 1815 L 20000 1815 L 20000 16252 C 19298 16252 18595 16352 18595 16352 M 2972 1815 L 2972 0 L 21600 0 L 21600 14392 C 20800 14392 20000 14467 20000 14467',
        w: 21600,
        h: 21600,
        fill: 'none'
      }
    ],
    text: 'l y2 x5 y8'
  },
  flowChartTerminator: {
    gd: 'il */ w 1018 21600; ir */ w 20582 21600; it */ h 3163 21600; ib */ h 18437 21600',
    paths: [{ d: 'M 3475 0 L 18125 0 A 3475 10800 3cd4 cd2 L 3475 21600 A 3475 10800 cd4 cd2 Z', w: 21600, h: 21600 }],
    text: 'il it ir ib'
  },
  flowChartPreparation: { gd: 'ir */ w 4 5', paths: [{ d: 'M 0 5 L 2 0 L 8 0 L 10 5 L 8 10 L 2 10 Z', w: 10, h: 10 }], text: 'wd5 t ir b' },
  flowChartManualInput: { paths: [{ d: 'M 0 1 L 5 0 L 5 5 L 0 5 Z', w: 5, h: 5 }], text: 'l hd5 r b' },
  flowChartManualOperation: { gd: 'x3 */ w 4 5', paths: [{ d: 'M 0 0 L 5 0 L 4 5 L 1 5 Z', w: 5, h: 5 }], text: 'wd5 t x3 b' },
  flowChartConnector: { gd: INSCRIBED, paths: [ELLIPSE], text: 'il it ir ib' },
  flowChartOffpageConnector: { gd: 'y1 */ h 4 5', paths: [{ d: 'M 0 0 L 10 0 L 10 8 L 5 10 L 0 8 Z', w: 10, h: 10 }], text: 'l t r y1' },
  flowChartPunchedCard: { paths: [{ d: 'M 0 1 L 1 0 L 5 0 L 5 5 L 0 5 Z', w: 5, h: 5 }], text: 'l hd5 r b' },
  flowChartPunchedTape: {
    gd: 'ib */ h 4 5',
    paths: [{ d: 'M 0 2 A 5 2 cd2 -10800000 A 5 2 cd2 cd2 L 20 18 A 5 2 0 -10800000 A 5 2 0 cd2 Z', w: 20, h: 20 }],
    text: 'l hd5 r ib'
  },
  flowChartSummingJunction: {
    gd: 'dx1 cos wd2 2700000; dy1 sin hd2 2700000; x1 +- hc 0 dx1; x2 +- hc dx1 0; y1 +- vc 0 dy1; y2 +- vc dy1 0',
    paths: [
      { d: ELLIPSE, stroke: false },
      { d: 'M x1 y1 L x2 y2 M x2 y1 L x1 y2', fill: 'none' },
      { d: ELLIPSE, fill: 'none' }
    ],
    text: 'x1 y1 x2 y2'
  },
  flowChartOr: {
    gd: 'dx1 cos wd2 2700000; dy1 sin hd2 2700000; x1 +- hc 0 dx1; x2 +- hc dx1 0; y1 +- vc 0 dy1; y2 +- vc dy1 0',
    paths: [
      { d: ELLIPSE, stroke: false },
      { d: 'M hc t L hc b M l vc L r vc', fill: 'none' },
      { d: ELLIPSE, fill: 'none' }
    ],
    text: 'x1 y1 x2 y2'
  },
  flowChartCollate: { gd: 'ir */ w 3 4; ib */ h 3 4', paths: [{ d: 'M 0 0 L 2 0 L 1 1 L 2 2 L 0 2 L 1 1 Z', w: 2, h: 2 }], text: 'wd4 hd4 ir ib' },
  flowChartSort: {
    gd: 'ir */ w 3 4; ib */ h 3 4',
    paths: [
      { d: 'M 0 1 L 1 0 L 2 1 L 1 2 Z', w: 2, h: 2, stroke: false },
      { d: 'M 0 1 L 2 1', w: 2, h: 2, fill: 'none' },
      { d: 'M 0 1 L 1 0 L 2 1 L 1 2 Z', w: 2, h: 2, fill: 'none' }
    ],
    text: 'wd4 hd4 ir ib'
  },
  flowChartExtract: { gd: 'x2 */ w 3 4', paths: [{ d: 'M 0 2 L 1 0 L 2 2 Z', w: 2, h: 2 }], text: 'wd4 vc x2 b' },
  flowChartMerge: { gd: 'x2 */ w 3 4', paths: [{ d: 'M 0 0 L 2 0 L 1 2 Z', w: 2, h: 2 }], text: 'wd4 t x2 vc' },
  flowChartOnlineStorage: { gd: 'x2 */ w 5 6', paths: [{ d: 'M 1 0 L 6 0 A 1 3 3cd4 -10800000 L 1 6 A 1 3 cd4 cd2 Z', w: 6, h: 6 }], text: 'wd6 t x2 b' },
  flowChartDelay: { gd: INSCRIBED, paths: ['M l t L hc t A wd2 hd2 3cd4 cd2 L l b Z'], text: 'l it ir ib' },
  flowChartMagneticDisk: {
    gd: 'y3 */ h 5 6',
    paths: [
      { d: 'M 0 1 A 3 1 cd2 cd2 L 6 5 A 3 1 0 cd2 Z', w: 6, h: 6, stroke: false },
      { d: 'M 6 1 A 3 1 0 cd2', w: 6, h: 6, fill: 'none' },
      { d: 'M 0 1 A 3 1 cd2 cd2 L 6 5 A 3 1 0 cd2 Z', w: 6, h: 6, fill: 'none' }
    ],
    text: 'l hd3 r y3'
  },
  flowChartDisplay: { gd: 'x2 */ w 5 6', paths: [{ d: 'M 0 3 L 1 0 L 5 0 A 1 3 3cd4 cd2 L 1 6 Z', w: 6, h: 6 }], text: 'wd6 t x2 b' }
}

import type { Deck, LineElement, ShapeKind, Slide, SlideElement } from './deck.ts'
import { center, lineEndsOnSlide, type Point, rotatePoint, withEndsOnSlide } from './elements.ts'

/*
 * Connection sites: the points of an element a connector's end is glued to, numbered as DrawingML
 * numbers them for its shape, so a connector read from a file lands where PowerPoint put it and one
 * written to a file stays glued there. Glued ends follow their elements as they move, and come
 * loose when the element goes or the end is dragged away.
 */

const ELLIPSE = 'idx=cos wd2 2700000;il=+- hc 0 idx;idy=sin hd2 2700000;it=+- vc 0 idy;ib=+- vc idy 0;ir=+- hc idx 0|hc,t@3cd4 il,it@3cd4 l,vc@cd2 il,ib@cd4 hc,b@cd4 ir,ib@cd4 r,vc ir,it@3cd4'

/**
 * Presets' connection sites as DrawingML's preset definitions give them: the guides they need
 * (DrawingML's formulas, a shape's adjust values by name), then each site's x and y and the way it
 * faces (0 when unsaid). Presets left out have the four sites of their box, as most do.
 */
const PRESET_SITES: Partial<Record<ShapeKind, string>> = {
  ellipse: ELLIPSE,
  triangle: 'adj=val 50000;a=pin 0 adj 100000;x2=*/ w a 100000;x1=*/ w a 200000;x3=+- x1 wd2 0|x2,t@3cd4 x1,vc@cd2 l,b@cd4 x2,b@cd4 r,b@cd4 x3,vc',
  rtTriangle: '|l,t@3cd4 l,vc@cd2 l,b@cd4 hc,b@cd4 r,b@cd4 hc,vc',
  parallelogram:
    'adj=val 25000;maxAdj=*/ 100000 w ss;a=pin 0 adj maxAdj;x2=*/ ss a 100000;q3=*/ h hc x2;y1=pin 0 q3 h;y2=+- b 0 y1;x5=+- r 0 x2;x3=*/ x5 1 2;x4=+- r 0 x3;x1=*/ ss a 200000;x6=+- r 0 x1|hc,y2@3cd4 x4,t@3cd4 x6,vc x3,b@cd4 hc,y1@cd4 x1,vc@cd2',
  trapezoid: 'adj=val 25000;maxAdj=*/ 50000 w ss;a=pin 0 adj maxAdj;x1=*/ ss a 200000;x4=+- r 0 x1|hc,t@3cd4 x1,vc@cd2 hc,b@cd4 x4,vc',
  pentagon:
    'hf=val 105146;swd2=*/ wd2 hf 100000;dx1=cos swd2 1080000;x1=+- hc 0 dx1;vf=val 110557;svc=*/ vc vf 100000;shd2=*/ hd2 vf 100000;dy1=sin shd2 1080000;y1=+- svc 0 dy1;dx2=cos swd2 18360000;x2=+- hc 0 dx2;dy2=sin shd2 18360000;y2=+- svc 0 dy2;x3=+- hc dx2 0;x4=+- hc dx1 0|hc,t@3cd4 x1,y1@cd2 x2,y2@cd4 hc,b@cd4 x3,y2@cd4 x4,y1',
  hexagon: 'adj=val 25000;maxAdj=*/ 50000 w ss;a=pin 0 adj maxAdj;x1=*/ ss a 100000;x2=+- r 0 x1;vf=val 115470;shd2=*/ hd2 vf 100000;dy1=sin shd2 3600000;y2=+- vc dy1 0;y1=+- vc 0 dy1|r,vc x2,y2@cd4 x1,y2@cd4 l,vc@cd2 x1,y1@3cd4 x2,y1@3cd4',
  octagon: 'adj=val 29289;a=pin 0 adj 50000;x1=*/ ss a 100000;y2=+- b 0 x1;x2=+- r 0 x1|r,x1 r,y2 x2,b@cd4 x1,b@cd4 l,y2@cd2 l,x1@cd2 x1,t@3cd4 x2,t@3cd4',
  star5:
    'hf=val 105146;swd2=*/ wd2 hf 100000;dx1=cos swd2 1080000;x1=+- hc 0 dx1;vf=val 110557;svc=*/ vc vf 100000;shd2=*/ hd2 vf 100000;dy1=sin shd2 1080000;y1=+- svc 0 dy1;dx2=cos swd2 18360000;x2=+- hc 0 dx2;dy2=sin shd2 18360000;y2=+- svc 0 dy2;x3=+- hc dx2 0;x4=+- hc dx1 0|hc,t@3cd4 x1,y1@cd2 x2,y2@cd4 x3,y2@cd4 x4,y1',
  rightArrow: 'adj2=val 50000;maxAdj2=*/ 100000 w ss;a2=pin 0 adj2 maxAdj2;dx1=*/ ss a2 100000;x1=+- r 0 dx1|x1,t@3cd4 l,vc@cd2 x1,b@cd4 r,vc',
  leftArrow: 'adj2=val 50000;maxAdj2=*/ 100000 w ss;a2=pin 0 adj2 maxAdj2;dx2=*/ ss a2 100000;x2=+- l dx2 0|x2,t@3cd4 l,vc@cd2 x2,b@cd4 r,vc',
  upArrow: 'adj2=val 50000;maxAdj2=*/ 100000 h ss;a2=pin 0 adj2 maxAdj2;dy2=*/ ss a2 100000;y2=+- t dy2 0|hc,t@3cd4 l,y2@cd2 hc,b@cd4 r,y2',
  downArrow: 'adj2=val 50000;maxAdj2=*/ 100000 h ss;a2=pin 0 adj2 maxAdj2;dy1=*/ ss a2 100000;y1=+- b 0 dy1|hc,t@3cd4 l,y1@cd2 hc,b@cd4 r,y1',
  leftRightArrow: 'adj2=val 50000;maxAdj2=*/ 50000 w ss;a2=pin 0 adj2 maxAdj2;x2=*/ ss a2 100000;x3=+- r 0 x2|r,vc x3,b@cd4 x2,b@cd4 l,vc@cd2 x2,t@3cd4 x3,t@3cd4',
  chevron: 'adj=val 50000;maxAdj=*/ 100000 w ss;a=pin 0 adj maxAdj;x1=*/ ss a 100000;x2=+- r 0 x1;x3=*/ x2 1 2|x3,t@3cd4 x1,vc@cd2 x3,b@cd4 r,vc',
  homePlate: 'adj=val 50000;maxAdj=*/ 100000 w ss;a=pin 0 adj maxAdj;dx1=*/ ss a 100000;x1=+- r 0 dx1;x2=*/ x1 1 2|x2,t@3cd4 l,vc@cd2 x1,b@cd4 r,vc',
  wedgeRectCallout: 'adj1=val -20833;dxPos=*/ w adj1 100000;xPos=+- hc dxPos 0;adj2=val 62500;dyPos=*/ h adj2 100000;yPos=+- vc dyPos 0|hc,t@3cd4 l,vc@cd2 hc,b@cd4 r,vc xPos,yPos@cd4',
  wedgeRoundRectCallout: 'adj1=val -20833;dxPos=*/ w adj1 100000;xPos=+- hc dxPos 0;adj2=val 62500;dyPos=*/ h adj2 100000;yPos=+- vc dyPos 0|hc,t@3cd4 l,vc@cd2 hc,b@cd4 r,vc xPos,yPos@cd4',
  snip1Rect: '|r,vc hc,b@cd4 l,vc@cd2 hc,t@3cd4',
  snip2SameRect: '|r,vc hc,b@cd4 l,vc@cd2 hc,t@3cd4',
  round2SameRect: '|r,vc hc,b@cd4 l,vc@cd2 hc,t@3cd4',
  bevel: 'adj=val 12500;a=pin 0 adj 50000;x1=*/ ss a 100000;x2=+- r 0 x1;y2=+- b 0 x1|r,vc x2,vc hc,b@cd4 hc,y2@cd4 l,vc@cd2 x1,vc@cd2 hc,t@3cd4 hc,x1@3cd4',
  star6: 'hf=val 115470;swd2=*/ wd2 hf 100000;dx1=cos swd2 1800000;x2=+- hc dx1 0;y2=+- vc hd4 0;x1=+- hc 0 dx1|x2,hd4 x2,y2 hc,b@cd4 x1,y2@cd2 x1,hd4@cd2 hc,t@3cd4',
  star8: 'dx1=cos wd2 2700000;x2=+- hc dx1 0;dy1=sin hd2 2700000;y2=+- vc dy1 0;x1=+- hc 0 dx1;y1=+- vc 0 dy1|r,vc x2,y2@cd4 hc,b@cd4 x1,y2@cd4 l,vc@cd2 x1,y1@3cd4 hc,t@3cd4 x2,y1@3cd4',
  donut: ELLIPSE,
  noSmoking: ELLIPSE,
  pie: '|r,vc hc,b@cd4 l,vc@cd2 hc,t@3cd4',
  heart: '|hc,hd4@3cd4 hc,b@cd4',
  moon: 'adj=val 50000;a=pin 0 adj 87500;g0=*/ ss a 100000;g0w=*/ g0 w ss|r,t@3cd4 l,vc@cd2 r,b@cd4 g0w,vc',
  cloud: 'g29=*/ w 21582 21600;g28=*/ h 21577 21600;g27=*/ w 67 21600;g30=*/ h 1235 21600|g29,vc hc,g28@cd4 g27,vc@cd2 hc,g30@3cd4',
  smileyFace: ELLIPSE,
  can: 'adj=val 25000;maxAdj=*/ 50000 h ss;a=pin 0 adj maxAdj;y1=*/ ss a 200000;y2=+- y1 y1 0|hc,y2@3cd4 hc,t@3cd4 l,vc@cd2 hc,b@cd4 r,vc',
  cube: 'adj=val 25000;a=pin 0 adj 100000;y1=*/ ss a 100000;x3=+/ y1 r 2;x4=+- r 0 y1;x2=*/ x4 1 2;y3=+/ y1 b 2;y4=+- b 0 y1;y2=*/ y4 1 2|x3,t@3cd4 x2,y1@3cd4 l,y3@cd2 x2,b@cd4 x4,y3 r,y2',
  leftBracket: '|r,t@cd4 l,vc@cd2 r,b@3cd4',
  rightBracket: '|l,t@cd4 l,b@3cd4 r,vc@cd2',
  leftBrace: 'adj2=val 50000;a2=pin 0 adj2 100000;y3=*/ h a2 100000|r,t@cd4 l,y3@cd2 r,b@3cd4',
  rightBrace: 'adj2=val 50000;a2=pin 0 adj2 100000;y3=*/ h a2 100000|l,t@cd4 r,y3@cd2 l,b@3cd4',
  upDownArrow:
    'adj2=val 50000;maxAdj2=*/ 50000 h ss;a2=pin 0 adj2 maxAdj2;y2=*/ ss a2 100000;adj1=val 50000;a1=pin 0 adj1 100000;dx1=*/ w a1 200000;x1=+- hc 0 dx1;y3=+- b 0 y2;x2=+- hc dx1 0|hc,t@3cd4 l,y2@cd2 x1,vc@cd2 l,y3@cd2 hc,b@cd4 r,y3 x2,vc r,y2',
  notchedRightArrow:
    'adj2=val 50000;maxAdj2=*/ 100000 w ss;a2=pin 0 adj2 maxAdj2;dx2=*/ ss a2 100000;x2=+- r 0 dx2;adj1=val 50000;a1=pin 0 adj1 100000;dy1=*/ h a1 200000;x1=*/ dy1 dx2 hd2|x2,t@3cd4 x1,vc@cd2 x2,b@cd4 r,vc',
  stripedRightArrow: 'adj2=val 50000;maxAdj2=*/ 84375 w ss;a2=pin 0 adj2 maxAdj2;dx5=*/ ss a2 100000;x5=+- r 0 dx5|x5,t@3cd4 l,vc@cd2 x5,b@cd4 r,vc',
  wedgeEllipseCallout:
    'idx=cos wd2 2700000;il=+- hc 0 idx;idy=sin hd2 2700000;it=+- vc 0 idy;ib=+- vc idy 0;ir=+- hc idx 0;adj1=val -20833;dxPos=*/ w adj1 100000;xPos=+- hc dxPos 0;adj2=val 62500;dyPos=*/ h adj2 100000;yPos=+- vc dyPos 0;sdx=*/ dxPos h 1;sdy=*/ dyPos w 1;pang=at2 sdx sdy|hc,t@3cd4 il,it@3cd4 il,ib@cd4 hc,b@cd4 ir,ib@cd4 r,vc ir,it@3cd4 xPos,yPos@pang',
  mathPlus: 'dx1=*/ w 73490 200000;x4=+- hc dx1 0;dy1=*/ h 73490 200000;y4=+- vc dy1 0;x1=+- hc 0 dx1;y1=+- vc 0 dy1|x4,vc hc,y4@cd4 x1,vc@cd2 hc,y1@3cd4',
  mathMinus: 'dx1=*/ w 73490 200000;x2=+- hc dx1 0;adj1=val 23520;a1=pin 0 adj1 100000;dy1=*/ h a1 200000;y2=+- vc dy1 0;x1=+- hc 0 dx1;y1=+- vc 0 dy1|x2,vc hc,y2@cd4 x1,vc@cd2 hc,y1@3cd4',
  flowChartInputOutput: 'x4=*/ w 3 5;x3=*/ w 2 5;x6=*/ w 9 10|x4,t@3cd4 hc,t@3cd4 wd10,vc@cd2 x3,b@cd4 hc,b@cd4 x6,vc',
  flowChartDocument: 'y2=*/ h 20172 21600|hc,t@3cd4 l,vc@cd2 hc,y2@cd4 r,vc',
  flowChartMultidocument: 'x4=*/ w 12286 21600;x3=*/ w 9298 21600;y8=*/ h 20782 21600|x4,t@3cd4 l,vc@cd2 x3,y8@cd4 r,vc',
  flowChartManualInput: '|hc,hd10@3cd4 l,vc@cd2 hc,b@cd4 r,vc',
  flowChartManualOperation: 'x4=*/ w 9 10|hc,t@3cd4 wd10,vc@cd2 hc,b@cd4 x4,vc',
  flowChartConnector: ELLIPSE,
  flowChartPunchedTape: 'y2=*/ h 9 10|hc,hd10@3cd4 l,vc@cd2 hc,y2@cd4 r,vc',
  flowChartSummingJunction: ELLIPSE,
  flowChartOr: ELLIPSE,
  flowChartCollate: '|hc,t@3cd4 hc,vc@3cd4 hc,b@cd4',
  flowChartExtract: 'x2=*/ w 3 4|hc,t@3cd4 wd4,vc@cd2 hc,b@cd4 x2,vc',
  flowChartMerge: 'x2=*/ w 3 4|hc,t@3cd4 wd4,vc@cd2 hc,b@cd4 x2,vc',
  flowChartOnlineStorage: 'x2=*/ w 5 6|hc,t@3cd4 l,vc@cd2 hc,b@cd4 x2,vc',
  flowChartMagneticDisk: '|hc,hd3@3cd4 hc,t@3cd4 l,vc@cd2 hc,b@cd4 r,vc'
}

/** DrawingML's angles are in 60,000ths of a degree. */
const DEGREE = 60000

interface SiteList {
  guides: Map<string, string[]>
  sites: [x: string, y: string, facing: string][]
}

const lists = new Map<ShapeKind, SiteList>()

function siteList(kind: ShapeKind): SiteList | undefined {
  const text = PRESET_SITES[kind]

  if (!text) {
    return undefined
  }

  let list = lists.get(kind)

  if (!list) {
    const [guides, sites] = text.split('|')
    list = {
      guides: new Map(
        guides
          .split(';')
          .filter(Boolean)
          .map((guide) => {
            const [name, formula] = guide.split('=')

            return [name, formula.trim().split(/\s+/)]
          })
      ),
      sites: sites.split(' ').map((site) => {
        const [place, facing = '0'] = site.split('@')
        const [x, y] = place.split(',')

        return [x, y, facing]
      })
    }
    lists.set(kind, list)
  }

  return list
}

function formula([op, ...args]: readonly string[], value: (token: string) => number): number {
  const [x = 0, y = 0, z = 0] = args.map(value)
  const radians = (angle: number) => (angle / DEGREE) * (Math.PI / 180)

  switch (op) {
    case '*/':
      return (x * y) / z
    case '+-':
      return x + y - z
    case '+/':
      return (x + y) / z
    case '?:':
      return x > 0 ? y : z
    case 'abs':
      return Math.abs(x)
    case 'at2':
      return ((Math.atan2(y, x) * 180) / Math.PI) * DEGREE
    case 'cat2':
      return x * Math.cos(Math.atan2(z, y))
    case 'cos':
      return x * Math.cos(radians(y))
    case 'max':
      return Math.max(x, y)
    case 'min':
      return Math.min(x, y)
    case 'mod':
      return Math.sqrt(x * x + y * y + z * z)
    case 'pin':
      return y < x ? x : y > z ? z : y
    case 'sat2':
      return x * Math.sin(Math.atan2(z, y))
    case 'sin':
      return x * Math.sin(radians(y))
    case 'sqrt':
      return Math.sqrt(x)
    case 'tan':
      return x * Math.tan(radians(y))
    default:
      return x
  }
}

/** What DrawingML's names and guides come to for a box of `w` by `h`, the shape's adjust values in place of the preset's. */
function guideValues(w: number, h: number, guides: ReadonlyMap<string, readonly string[]>, adjust: Readonly<Record<string, number>>): (token: string) => number {
  const ss = Math.min(w, h)
  const known = new Map<string, number>([
    ['l', 0],
    ['t', 0],
    ['r', w],
    ['b', h],
    ['w', w],
    ['h', h],
    ['hc', w / 2],
    ['vc', h / 2],
    ['ss', ss],
    ['ls', Math.max(w, h)],
    ['cd2', 180 * DEGREE],
    ['cd4', 90 * DEGREE],
    ['cd8', 45 * DEGREE],
    ['3cd4', 270 * DEGREE],
    ['3cd8', 135 * DEGREE],
    ['5cd8', 225 * DEGREE],
    ['7cd8', 315 * DEGREE]
  ])
  const value = (token: string): number => {
    const literal = Number(token)

    if (Number.isFinite(literal)) {
      return literal
    }

    const cached = known.get(token)

    if (cached !== undefined) {
      return cached
    }

    const part = /^(wd|hd|ssd)(\d+)$/.exec(token)
    const guide = guides.get(token)
    // A guide that leads back to itself counts as 0 instead of recursing forever.
    known.set(token, 0)
    const result = part ? { wd: w, hd: h, ssd: ss }[part[1] as 'wd' | 'hd' | 'ssd'] / Number(part[2]) : Number.isFinite(adjust[token]) && /^adj\d*$/.test(token) ? adjust[token] : guide ? formula(guide, value) : 0
    known.set(token, Number.isFinite(result) ? result : 0)

    return known.get(token) ?? 0
  }

  return value
}

/** An element's connection sites in its own box, before flips and rotation, each with the way it faces in degrees (0 right, 90 down). */
function localSites(element: SlideElement): [number, number, number][] {
  const { width: w, height: h } = element

  if (element.kind === 'line') {
    return element.connector
      ? []
      : [
          [0, 0, 90],
          [w, h, 270]
        ]
  }

  const list = element.kind === 'shape' && !element.paths?.length ? siteList(element.shape) : undefined

  if (!list) {
    return [
      [w / 2, 0, 270],
      [0, h / 2, 180],
      [w / 2, h, 90],
      [w, h / 2, 0]
    ]
  }

  const value = guideValues(w, h, list.guides, element.kind === 'shape' ? (element.adjust ?? {}) : {})

  return list.sites.map(([x, y, facing]) => [value(x), value(y), value(facing) / DEGREE])
}

const turn = (degrees: number): number => ((degrees % 360) + 360) % 360

function placedSites(element: SlideElement): { point: Point; facing: number }[] {
  const middle = center(element)

  return localSites(element).map(([x, y, facing]) => {
    const point = rotatePoint([element.x + (element.flipH ? element.width - x : x), element.y + (element.flipV ? element.height - y : y)], middle, element.rotation)
    const flipped = element.flipV ? -(element.flipH ? 180 - facing : facing) : element.flipH ? 180 - facing : facing

    return { point, facing: turn(flipped + element.rotation) }
  })
}

/**
 * An element's connection sites on the slide, flips and rotation applied, in DrawingML's order for
 * its shape: a box's (a text box's, a picture's, a table's, a rectangle's) top, left, bottom and
 * right; an ellipse's eight from the top round to the left; a line's two ends; none on a connector.
 */
export const connectionSites = (element: SlideElement): Point[] => placedSites(element).map((site) => site.point)

/** The way a connection site faces on the slide, in degrees: 0 right, 90 down, 180 left, 270 up (0 when there is no such site). */
export const siteFacing = (element: SlideElement, site: number): number => placedSites(element)[site]?.facing ?? 0

const distance = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1])

/** The element's connection site nearest a point on the slide, or -1 when it has none. */
export function nearestSite(element: SlideElement, point: Point): number {
  return connectionSites(element).reduce((best, site, index, sites) => (best < 0 || distance(site, point) < distance(sites[best], point) ? index : best), -1)
}

/** How near a site a moved end still counts as on it, in points. */
const ON_SITE = 0.5

/**
 * A connector with its glued ends on its elements' sites. Given the slide as it was, an end follows
 * only an element that moved; an end dragged off a site that stayed comes loose. An end glued to an
 * element that is gone comes loose where it is.
 */
function route(line: LineElement, elements: ReadonlyMap<string, SlideElement>, before: ReadonlyMap<string, SlideElement> | undefined): LineElement {
  const link = line.connector

  if (!link?.start && !link?.end) {
    return line
  }

  const ends = lineEndsOnSlide(line)
  const was = before?.get(line.id)
  const wasEnds = was?.kind === 'line' ? lineEndsOnSlide(was) : undefined
  let connector = link
  let from = ends.from
  let to = ends.to

  for (const side of ['start', 'end'] as const) {
    const glued = connector[side]

    if (!glued) {
      continue
    }

    const target = elements.get(glued.element)
    const site = target && target !== line ? connectionSites(target)[glued.site] : undefined
    const at = side === 'start' ? from : to

    if (!site) {
      connector = { ...connector }
      delete connector[side]
      continue
    }

    const old = before?.get(glued.element)
    const oldSite = old ? connectionSites(old)[glued.site] : undefined

    if (before && oldSite && distance(oldSite, site) <= 1e-6) {
      const dragged = wasEnds && distance(side === 'start' ? wasEnds.from : wasEnds.to, at) > 1e-6

      if (dragged && distance(at, site) > ON_SITE) {
        connector = { ...connector }
        delete connector[side]
      }

      continue
    }

    if (distance(at, site) <= 1e-9) {
      continue
    }

    if (side === 'start') {
      from = site
    } else {
      to = site
    }
  }

  if (connector === link && from === ends.from && to === ends.to) {
    return line
  }

  const moved = from === ends.from && to === ends.to ? line : withEndsOnSlide(line, from, to)

  return { ...moved, connector }
}

/**
 * A slide with its connectors' glued ends on the sites they are glued to (the same slide when none
 * moves). Given the slide before a change, ends follow only the elements that moved, and an end
 * dragged away from its site comes loose.
 */
export function routeConnectors(slide: Slide, previous?: Slide): Slide {
  if (!slide.elements.some((element) => element.kind === 'line' && (element.connector?.start || element.connector?.end))) {
    return slide
  }

  const elements = new Map(slide.elements.map((element) => [element.id, element]))
  const before = previous && new Map(previous.elements.map((element) => [element.id, element]))
  let changed = false
  const next = slide.elements.map((element) => {
    const routed = element.kind === 'line' ? route(element, elements, before) : element
    changed ||= routed !== element

    return routed
  })

  return changed ? { ...slide, elements: next } : slide
}

/** A deck with its connectors routed on the slides that changed since `previous` (on every slide without it); the same deck when none moves. */
export function routeDeck(deck: Deck, previous?: Deck): Deck {
  const before = previous && new Map(previous.slides.map((slide) => [slide.id, slide]))
  let changed = false
  const slides = deck.slides.map((slide) => {
    const old = before?.get(slide.id)
    const routed = old === slide ? slide : routeConnectors(slide, old)
    changed ||= routed !== slide

    return routed
  })

  return changed ? { ...deck, slides } : deck
}

/** Copies with their connectors glued to the copies of what the originals were glued to (`ids` maps an original's id to its copy's); ends glued to anything not copied come loose. */
export function relinkCopies(copies: readonly SlideElement[], ids: ReadonlyMap<string, string>): SlideElement[] {
  return copies.map((element) => {
    if (element.kind !== 'line' || (!element.connector?.start && !element.connector?.end)) {
      return element
    }

    const connector = { ...element.connector }

    for (const side of ['start', 'end'] as const) {
      const glued = connector[side]
      const copy = glued && ids.get(glued.element)

      if (glued && copy) {
        connector[side] = { ...glued, element: copy }
      } else {
        delete connector[side]
      }
    }

    return { ...element, connector }
  })
}

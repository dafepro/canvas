# Soccer lounge asset provenance

`public/assets/soccer-ball-impact.png` was generated with OpenAI image
generation on 2026-08-23. It is a 1254×1254 transparent PNG arranged as four
equal 627×627 atlas frames.

Final generation prompt:

> Use case: stylized-concept. Asset type: top-down 2D multiplayer game sprite
> sheet. Primary request: create a single transparent sprite sheet containing
> exactly four frames of the same classic black-and-off-white soccer ball
> deforming during a hard kick. Scene/backdrop: genuinely transparent
> background across the entire image. Subject: one soccer ball per quadrant;
> top-left perfectly round idle ball, top-right slightly horizontally compressed
> impact ball, bottom-left horizontally stretched rebound ball, bottom-right
> nearly round settling ball. Style/medium: polished clean 2D game sprite,
> subtle hand-painted shading, top-down view, crisp silhouette.
> Composition/framing: exact 2 by 2 equal grid; one centered ball in each
> quadrant; every ball uses the same scale and visual identity; generous
> transparent padding; no grid lines or dividers. Color palette: off-white
> leather with charcoal-black panels, restrained neutral shading. Constraints:
> transparent alpha; exactly four balls; no text; no numbers; no logos; no
> watermark; no grass; no field; no shadow crossing quadrant boundaries; no
> extra objects.

The field remains a repository-native SVG because its artwork must align with
precise, reviewable collision and goal geometry. Its pixels do not define the
physics.

## Goal and net

`public/assets/soccer-goal-net.png` was generated with OpenAI image generation
on 2026-08-23. It is an 860×1828 transparent portrait sprite used by both
room-owned goal items; the right-side item rotates the same texture 180
degrees. The asset manifest crops its alpha content to pixels
`121,62–732,1703`, making the front post the exact outer texture edge that is
placed on the configured goal line.

Final composition prompt:

> Create a 3D orthographic PLAN-VIEW render of one soccer goal for an overhead
> video game. The camera looks almost straight down at the goal from the sky,
> tilted only 15 degrees toward the pitch. The goal must appear as a shallow
> rectangular/trapezoidal footprint, approximately 10 units wide horizontally
> by 22 units tall vertically in the portrait image—not as a tall upright
> front-facing rectangle. Think architectural roof plan or drone view: the roof
> net fills the shallow rectangle; the front crossbar/uprights rise only
> slightly and are visible as a small 3D offset. Layout coordinates: a perfectly
> straight vertical front goal-line frame near the RIGHT edge from y=10% to
> y=90%; a parallel rear frame near the LEFT edge; short top and bottom side
> frames connect them; netting spans the roof and rear. Opening faces RIGHT.
> White metal tubes and white net, polished but readable game art, orthographic
> projection, no shadow. Place the isolated goal on a uniform saturated
> royal-blue chroma-key background (#0000FF) with no texture, gradient,
> checkerboard, field, ball, players, text, or logo. Large object, clean margins.

Final transparency pass:

> Preserve the soccer goal object, its exact overhead 15-degree camera angle,
> dimensions, framing, white posts, and net. Remove only the saturated
> royal-blue chroma background and replace it with true RGBA transparency. Clean
> any blue spill from the white edges. Do not add, remove, rotate, redraw, crop,
> or change the goal. No checkerboard pattern, shadow, field, or new background.
> The PNG pixels outside the goal must have alpha 0.

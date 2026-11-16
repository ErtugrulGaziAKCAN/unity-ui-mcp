List rows show one record each in a column of rows: an avatar, a name, a position and a rating, under a header row.

**Compiles to** a repeated template: the first row carries `data-u-repeat`, the written-out samples after it share its structure, and the generated view binds one item per row.

**Markup:** `<li class="list-row" data-u-repeat="players" data-u-id="player" data-u-action="open-player">` with bound cells `<span data-u-id="name" data-u-bind="player.name">Name</span>`; every sample row repeats the same ids and binds.

**States:** `:hover` and `:active` change the background, `.is-selected` marks the chosen row.

**Do:** give rows a fixed height and fixed cell widths so columns line up; align numbers right with `text-align: right`.

**Don't:** vary the structure between sample rows, or put other elements in the repeat container (U-MRK-010).

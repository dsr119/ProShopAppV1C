-- Doug's list of common Square items and how they're said (2026-10-28).
-- When what's said contains `spoken`, the voice assistant searches Square for
-- `square_item`. Run through Supabase SQL Editor after add_voice_aliases.sql.
-- Safe to run again: an existing phrase is pointed at the item below.
insert into public.voice_aliases (spoken, square_item) values
    ('standard drill',     'Fit & Drill New Ball Purchased at Perfexxxxion Pro Shop'),
    ('drilling fee',       'Fit & Drill New Ball Purchased at Perfexxxxion Pro Shop'),
    ('35 drill',           'Fit & Drill New Ball Purchased at Perfexxxxion Pro Shop'),
    ('35 dollar drill',    'Fit & Drill New Ball Purchased at Perfexxxxion Pro Shop'),
    ('5 grips',            'Pair of Grips w/New Ball Purchase'),
    ('5 dollar grips',     'Pair of Grips w/New Ball Purchase'),
    ('10 grips',           'Pair of Grips'),
    ('10 dollar grips',    'Pair of Grips'),
    ('10 pair of grips',   'Pair of Grips'),
    ('10 dollar pair of grips', 'Pair of Grips'),
    ('jopo outer',         'Jopo Outer Sleeve Locking System'),
    ('jopo sleeve',        'Jopo Outer Sleeve Locking System'),
    ('slombo',             'Grip/Slug Combo with Purchase'),
    ('slug combo',         'Grip/Slug Combo with Purchase'),
    ('blank drill',        'Fit & Drill New Ball Purchased Elsewhere'),
    ('external drill',     'Fit & Drill New Ball Purchased Elsewhere'),
    ('outside drill',      'Fit & Drill New Ball Purchased Elsewhere'),
    ('50 drill',           'Fit & Drill New Ball Purchased Elsewhere'),
    ('50 dollar drill',    'Fit & Drill New Ball Purchased Elsewhere'),
    ('full plug',          'Full Plug & Redrill'),
    ('turbo outer',        'Turbo Outer Sleeve Locking System'),
    ('turbo outter',       'Turbo Outer Sleeve Locking System'),
    ('turbo sleeve',       'Turbo Outer Sleeve Locking System'),
    ('jopo thumb',         'Jopo/Make Thumb'),
    ('jopo make thumb',    'Jopo/Make Thumb'),
    ('jopo inner',         'Jopo/Make Thumb'),
    ('vise kt tape',       'Vise K + Tape'),
    ('vise k tape',        'Vise K + Tape'),
    ('turbo switch grip',  'Turbo Switch Grip/Make Thumb'),
    ('turbo inner',        'Turbo Switch Grip/Make Thumb'),
    ('turbo make thumb',   'Turbo Switch Grip/Make Thumb'),
    ('turbo thumb',        'Turbo Switch Grip/Make Thumb'),
    ('turbo tumb',         'Turbo Switch Grip/Make Thumb')
on conflict (spoken) do update set square_item = excluded.square_item;

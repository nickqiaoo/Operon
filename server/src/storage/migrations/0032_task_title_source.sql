-- Who wrote the task's title: 'user' (typed by a person or an agent — every
-- existing task) or 'auto' (left blank at creation; the server put a
-- placeholder from the description and is replacing it with a generated one).
-- Any later title edit makes it 'user', so a generated title never overwrites it.
ALTER TABLE tasks ADD COLUMN title_source TEXT NOT NULL DEFAULT 'user' CHECK (title_source IN ('user', 'auto'));

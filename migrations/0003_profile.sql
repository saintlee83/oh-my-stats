-- What the owner wrote for their profile header on the website, as JSON. Empty fields use their GitHub profile.
ALTER TABLE users ADD COLUMN profile TEXT;

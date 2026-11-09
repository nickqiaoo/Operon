-- The questions a message asks the user: json AssistantQuestion[].
ALTER TABLE assistant_messages ADD COLUMN questions_json TEXT;

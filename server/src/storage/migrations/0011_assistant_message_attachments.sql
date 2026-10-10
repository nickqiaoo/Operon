-- Files the user sent with a message (images, text files…): json AssistantAttachment[].
ALTER TABLE assistant_messages ADD COLUMN attachments_json TEXT;

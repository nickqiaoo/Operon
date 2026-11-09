import { memo, useMemo, type ComponentProps } from 'react';
import { usePromptInputController } from '@/components/ai-elements/prompt-input-context';
import { useOperonSkills } from '@/lib/skill-queries';
import { ChatInputArea } from './ChatInputArea';

type ChatComposerProps = Omit<ComponentProps<typeof ChatInputArea>, 'input' | 'setInput' | 'attachments'> & {
  isOperonProvider: boolean;
  dbChatId: number | undefined;
};

export const ChatComposer = memo(function ChatComposer({ isOperonProvider, dbChatId, slashCommands, ...props }: ChatComposerProps) {
  const { textInput: { value: input, setInput }, attachments } = usePromptInputController();
  const { data: skills } = useOperonSkills(dbChatId, isOperonProvider && input.startsWith('/'));
  const mergedSlashCommands = useMemo(() => {
    if (!isOperonProvider || !skills?.length) return slashCommands;
    return [...slashCommands, ...skills.map((skill) => ({
      name: skill.name, description: skill.description, type: 'skill' as const,
    }))];
  }, [isOperonProvider, skills, slashCommands]);
  return <ChatInputArea {...props} input={input} setInput={setInput} attachments={attachments} slashCommands={mergedSlashCommands} />;
});

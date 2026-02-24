import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
import { ContentGenerationConsole } from '@gitroom/frontend/components/content-generation/content-generation.console';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Postiz' : 'Gitroom'} Creation`,
  description: '',
};

export default async function Page() {
  return <ContentGenerationConsole />;
}


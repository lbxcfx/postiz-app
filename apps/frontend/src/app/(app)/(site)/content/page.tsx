import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
import { FactoryConsole } from '@gitroom/frontend/components/content-factory/factory.console';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Postiz' : 'Gitroom'} Content`,
  description: '',
};

export default async function Page() {
  return (
    <FactoryConsole
      view="content"
      title="采集内容库"
      subtitle="按关键词、作者、发布时间筛选源内容"
      badge="CONTENT"
    />
  );
}

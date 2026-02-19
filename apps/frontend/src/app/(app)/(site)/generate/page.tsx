import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
import { FactoryConsole } from '@gitroom/frontend/components/content-factory/factory.console';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Postiz' : 'Gitroom'} Generate`,
  description: '',
};

export default async function Page() {
  return (
    <FactoryConsole
      view="generate"
      title="生成与审核"
      subtitle="输入产品画像，生成草稿并执行审核动作"
      badge="GENERATE"
    />
  );
}

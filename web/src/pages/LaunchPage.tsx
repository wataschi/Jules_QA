import PageHeader from '../components/PageHeader';
import LaunchForm from '../components/LaunchForm';

export default function LaunchPage() {
  return (
    <>
      <PageHeader
        title="Запуск тестів"
        subtitle="Оберіть URL, режим AI (warm-up / regression) та сценарій або набір"
      />
      <div className="help-banner">
        <strong>Warm-up</strong> — AI досліджує UI і кешує локатори. <strong>Regression</strong> — швидкий повтор з кешем.
        URL не зберігається в сценарії — один набір працює на будь-якому сайті.
      </div>
      <LaunchForm />
    </>
  );
}

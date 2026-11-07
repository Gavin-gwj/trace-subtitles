import { FaqSection } from "./components/FaqSection.jsx";
import { FeatureRows } from "./components/FeatureRows.jsx";
import { Footer } from "./components/Footer.jsx";
import { Header } from "./components/Header.jsx";
import { Hero } from "./components/Hero.jsx";
import { InstallSection } from "./components/InstallSection.jsx";
import { WordbookSection } from "./components/WordbookSection.jsx";

export function App() {
  return (
    <>
      <Header />
      <main>
        <Hero />
        <FeatureRows />
        <WordbookSection />
        <InstallSection />
        <FaqSection />
      </main>
      <Footer />
    </>
  );
}

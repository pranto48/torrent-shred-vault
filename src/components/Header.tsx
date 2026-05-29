import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Shield, Menu, X } from "lucide-react";

const navLinks = [
  { href: "#features", label: "Features" },
  { href: "#how-it-works", label: "How It Works" },
  { href: "#pricing", label: "Pricing" },
  { href: "#docs", label: "Documentation" },
];

const Header = () => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-md border-b border-border/50">
      <div className="container mx-auto px-6">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-lg bg-gradient-primary">
              <Shield className="w-6 h-6 text-primary-foreground" />
            </div>
            <span className="text-xl font-bold bg-gradient-primary bg-clip-text text-transparent">
              EncryptStore
            </span>
          </div>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center space-x-8">
            {navLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                {link.label}
              </a>
            ))}
          </nav>

          {/* Auth Buttons (desktop) */}
          <div className="flex items-center space-x-4">
            <Button variant="ghost" className="hidden sm:inline-flex" asChild>
              <a href="/auth">Sign In</a>
            </Button>
            <Button variant="glow" asChild className="hidden md:inline-flex">
              <a href="/auth">Get Started</a>
            </Button>

            {/* Hamburger (mobile only) */}
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label={isMenuOpen ? "Close menu" : "Open menu"}
              onClick={() => setIsMenuOpen((prev) => !prev)}
            >
              {isMenuOpen ? (
                <X className="w-5 h-5" />
              ) : (
                <Menu className="w-5 h-5" />
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* Mobile Dropdown Nav */}
      {isMenuOpen && (
        <div className="md:hidden border-t border-border/50 bg-background/95 backdrop-blur-md">
          <nav className="container mx-auto px-6 py-4 flex flex-col gap-1">
            {navLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setIsMenuOpen(false)}
                className="text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors rounded-md px-3 py-2.5 text-sm font-medium"
              >
                {link.label}
              </a>
            ))}
            <div className="pt-3 border-t border-border/50 mt-2 flex flex-col gap-2">
              <Button variant="ghost" className="w-full justify-start" asChild>
                <a href="/auth" onClick={() => setIsMenuOpen(false)}>
                  Sign In
                </a>
              </Button>
              <Button variant="glow" className="w-full" asChild>
                <a href="/auth" onClick={() => setIsMenuOpen(false)}>
                  Get Started
                </a>
              </Button>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
};

export default Header;
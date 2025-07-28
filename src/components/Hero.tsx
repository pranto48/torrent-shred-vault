import { Button } from "@/components/ui/button";
import { Shield, Database, Network, Lock } from "lucide-react";
import heroImage from "@/assets/hero-image.jpg";

const Hero = () => {
  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden">
      {/* Background Image */}
      <div 
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: `url(${heroImage})` }}
      >
        <div className="absolute inset-0 bg-background/80 backdrop-blur-sm"></div>
      </div>
      
      {/* Animated Background Elements */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-20 left-1/4 w-2 h-2 bg-cyber-green rounded-full animate-pulse-glow"></div>
        <div className="absolute top-1/3 right-1/4 w-1 h-1 bg-cyber-blue rounded-full animate-pulse-glow delay-1000"></div>
        <div className="absolute bottom-1/3 left-1/3 w-1.5 h-1.5 bg-cyber-purple rounded-full animate-pulse-glow delay-500"></div>
        <div className="absolute bottom-20 right-1/3 w-2 h-2 bg-cyber-orange rounded-full animate-pulse-glow delay-1500"></div>
      </div>

      {/* Content */}
      <div className="relative z-10 container mx-auto px-6 text-center">
        <div className="max-w-4xl mx-auto">
          {/* Main Heading */}
          <h1 className="text-5xl md:text-7xl font-bold mb-6 bg-gradient-primary bg-clip-text text-transparent animate-float">
            Encrypted Torrent Storage
          </h1>
          
          {/* Subtitle */}
          <p className="text-xl md:text-2xl text-muted-foreground mb-8 leading-relaxed">
            Distributed, encrypted, and redundant file storage that combines the power of 
            <span className="text-cyber-green font-semibold"> peer-to-peer networks</span> with 
            <span className="text-cyber-blue font-semibold"> military-grade encryption</span>
          </p>
          
          {/* Feature Highlights */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-12">
            <div className="flex flex-col items-center space-y-2 p-4 rounded-lg bg-card/50 backdrop-blur-sm border border-border/50 hover:shadow-card transition-all duration-300">
              <Shield className="w-8 h-8 text-cyber-green" />
              <span className="text-sm font-medium">Military Encryption</span>
            </div>
            <div className="flex flex-col items-center space-y-2 p-4 rounded-lg bg-card/50 backdrop-blur-sm border border-border/50 hover:shadow-card transition-all duration-300">
              <Database className="w-8 h-8 text-cyber-blue" />
              <span className="text-sm font-medium">RAID-like Redundancy</span>
            </div>
            <div className="flex flex-col items-center space-y-2 p-4 rounded-lg bg-card/50 backdrop-blur-sm border border-border/50 hover:shadow-card transition-all duration-300">
              <Network className="w-8 h-8 text-cyber-purple" />
              <span className="text-sm font-medium">P2P Distribution</span>
            </div>
            <div className="flex flex-col items-center space-y-2 p-4 rounded-lg bg-card/50 backdrop-blur-sm border border-border/50 hover:shadow-card transition-all duration-300">
              <Lock className="w-8 h-8 text-cyber-orange" />
              <span className="text-sm font-medium">Zero Knowledge</span>
            </div>
          </div>
          
          {/* Call to Action Buttons */}
          <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
            <Button variant="cyber" size="xl" className="min-w-48">
              Join the Network
            </Button>
            <Button variant="glow" size="xl" className="min-w-48">
              Learn More
            </Button>
          </div>
          
          {/* Stats */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mt-16 pt-8 border-t border-border/50">
            <div className="text-center">
              <div className="text-3xl font-bold text-cyber-green mb-2">∞</div>
              <div className="text-sm text-muted-foreground">Scalable Storage</div>
            </div>
            <div className="text-center">
              <div className="text-3xl font-bold text-cyber-blue mb-2">100%</div>
              <div className="text-sm text-muted-foreground">Data Redundancy</div>
            </div>
            <div className="text-center">
              <div className="text-3xl font-bold text-cyber-purple mb-2">0</div>
              <div className="text-sm text-muted-foreground">Single Points of Failure</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Hero;
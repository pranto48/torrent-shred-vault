import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { 
  Upload, 
  Scissors, 
  Shield, 
  Network, 
  Download,
  ArrowRight
} from "lucide-react";

const HowItWorks = () => {
  const steps = [
    {
      icon: Upload,
      title: "Upload Your Files",
      description: "Select files from your local storage to be added to the distributed network.",
      step: "01"
    },
    {
      icon: Scissors,
      title: "Chunking & Erasure Coding",
      description: "Files are split into encrypted chunks with Reed-Solomon parity data for redundancy.",
      step: "02"
    },
    {
      icon: Shield,
      title: "Military-Grade Encryption",
      description: "Each chunk is encrypted with AES-256 using your personal encryption key.",
      step: "03"
    },
    {
      icon: Network,
      title: "P2P Distribution",
      description: "Encrypted chunks are distributed across multiple peer storage buckets worldwide.",
      step: "04"
    },
    {
      icon: Download,
      title: "Seamless Recovery",
      description: "Retrieve your files from any device by reconstructing chunks from available peers.",
      step: "05"
    }
  ];

  return (
    <section className="py-24 relative overflow-hidden">
      {/* Background Animation */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/4 left-0 w-full h-px bg-gradient-to-r from-transparent via-cyber-green/30 to-transparent animate-data-flow"></div>
        <div className="absolute top-2/4 left-0 w-full h-px bg-gradient-to-r from-transparent via-cyber-blue/30 to-transparent animate-data-flow delay-1000"></div>
        <div className="absolute top-3/4 left-0 w-full h-px bg-gradient-to-r from-transparent via-cyber-purple/30 to-transparent animate-data-flow delay-2000"></div>
      </div>

      <div className="container mx-auto px-6 relative z-10">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold mb-6 bg-gradient-secondary bg-clip-text text-transparent">
            How It Works
          </h2>
          <p className="text-xl text-muted-foreground max-w-3xl mx-auto">
            A simple 5-step process that transforms your files into an indestructible, distributed storage network
          </p>
        </div>

        <div className="max-w-6xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-8 items-start">
            {steps.map((step, index) => {
              const Icon = step.icon;
              const isLast = index === steps.length - 1;
              
              return (
                <div key={index} className="relative">
                  <Card className="p-6 bg-card/50 backdrop-blur-sm border-border/50 hover:shadow-card transition-all duration-300 text-center group">
                    {/* Step Number */}
                    <div className="absolute -top-4 left-1/2 transform -translate-x-1/2">
                      <div className="w-8 h-8 bg-gradient-primary rounded-full flex items-center justify-center text-sm font-bold text-primary-foreground">
                        {step.step}
                      </div>
                    </div>
                    
                    {/* Icon */}
                    <div className="mb-4 flex justify-center">
                      <div className="p-4 rounded-full bg-background/50 text-cyber-green group-hover:animate-pulse-glow">
                        <Icon className="w-8 h-8" />
                      </div>
                    </div>
                    
                    {/* Content */}
                    <h3 className="text-lg font-semibold mb-3 group-hover:text-primary transition-colors">
                      {step.title}
                    </h3>
                    <p className="text-muted-foreground text-sm leading-relaxed">
                      {step.description}
                    </p>
                  </Card>
                  
                  {/* Arrow Connector */}
                  {!isLast && (
                    <div className="hidden lg:block absolute top-1/2 -right-4 transform -translate-y-1/2 z-20">
                      <ArrowRight className="w-6 h-6 text-cyber-blue animate-pulse" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Call to Action */}
        <div className="text-center mt-16">
          <div className="max-w-2xl mx-auto mb-8">
            <h3 className="text-2xl font-bold mb-4">Ready to Secure Your Data?</h3>
            <p className="text-muted-foreground">
              Join thousands of users already protecting their files with our revolutionary storage technology
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button variant="cyber" size="lg">
              Create Your Account
            </Button>
            <Button variant="neon" size="lg">
              Download Client App
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
};

export default HowItWorks;